import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

function snapshot(path) {
  const named = lstatSync(path, { bigint: true });
  if (!named.isFile()) {
    throw new Error("Merge body must be a regular file, not a symlink.");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || named.dev !== before.dev || named.ino !== before.ino) {
      throw new Error("Merge body must be a regular file.");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some((key) => before[key] !== after[key])) {
      throw new Error("Merge body changed while reading; retry with a stable file.");
    }
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bytes.includes(0)) {
      throw new Error("Merge body must not contain NUL bytes.");
    }
    return {
      base64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    closeSync(fd);
  }
}

function trailers(body) {
  // Parse only: mutating interpret-trailers can execute configured commands.
  const parsed = spawnSync(
    "git",
    [
      "-c",
      "trailer.separators=:",
      "-c",
      "trailer.co-authored-by.key=Co-authored-by",
      "interpret-trailers",
      "--parse",
      "--no-divider",
    ],
    {
      input: `OpenClaw merge message\n\n${body}`,
      encoding: "utf8",
    },
  );
  if (parsed.error || parsed.status !== 0) {
    throw new Error("Cannot parse squash message trailers.");
  }
  return parsed.stdout.split("\n").filter(Boolean);
}

// Published machine identities: exact addresses plus GitHub App `[bot]`
// no-reply accounts, which cannot belong to a person. Never match names or
// provider domains; humans commit from @openai.com and @anthropic.com too.
const MACHINE_CREDIT_EMAILS = new Set([
  "noreply@anthropic.com",
  "cursoragent@cursor.com",
  "amp@ampcode.com",
  "codex@openai.com",
  "noreply@openai.com",
  "solo-agent@trae.ai",
  "175728472+copilot@users.noreply.github.com",
  "198982749+copilot@users.noreply.github.com",
  "223556219+copilot@users.noreply.github.com",
  "309084314+roboclaw-bot@users.noreply.github.com",
]);
const GITHUB_APP_BOT_EMAIL = /^(?:\d+\+)?[^@\s]*\[bot\]@users\.noreply\.github\.com$/;

function isCredit(line) {
  return /^Co-authored-by:/i.test(line);
}

function creditEmail(line) {
  const match = /^Co-authored-by:\s*[^<>]+<([^<>\r\n]+)>$/i.exec(line);
  return match ? match[1].trim().toLowerCase() : undefined;
}

function isMachineCredit(line) {
  const email = creditEmail(line);
  return (
    email !== undefined && (MACHINE_CREDIT_EMAILS.has(email) || GITHUB_APP_BOT_EMAIL.test(email))
  );
}

function coauthorEmail(line) {
  const email = creditEmail(line);
  if (email === undefined) {
    throw new Error(`Cannot validate squash preview co-author: ${JSON.stringify(line)}.`);
  }
  return email;
}

function splitLines(text) {
  return text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
}

// Physical line indexes carrying machine credit anywhere in a message,
// including an indented key line or a trailer folded onto indented
// continuation lines. The identity is checked at every unfolding step so
// indented text after a complete trailer cannot hide it.
function machineCreditLines(lines) {
  const indexes = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    let unfolded = lines[index].trim();
    if (!isCredit(unfolded)) {
      continue;
    }
    for (let end = index; ; end += 1) {
      if (isMachineCredit(unfolded)) {
        for (let line = index; line <= end; line += 1) {
          indexes.add(line);
        }
        break;
      }
      if (end + 1 >= lines.length || !/^[ \t]+\S/.test(lines[end + 1])) {
        break;
      }
      unfolded += ` ${lines[end + 1].trim()}`;
    }
  }
  return indexes;
}

function prunePreview(lines, unsupported, machineIndexes) {
  const counts = new Map();
  for (const credit of unsupported) {
    const normalized = credit.toLowerCase();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  const dropIndexes = new Set(machineIndexes);
  for (const [expected, count] of counts) {
    const matches = lines.flatMap((line, index) =>
      line.replace(/\r?\n$/, "").toLowerCase() === expected ? [index] : [],
    );
    if (matches.length !== count) {
      throw new Error("Cannot remove unsupported squash preview credit unambiguously.");
    }
    for (const index of matches) {
      dropIndexes.add(index);
    }
  }
  // GitHub replays every commit message, so machine credit also appears inside
  // per-commit bullets, not only in the terminal trailer block. Drop it
  // wherever it sits, along with a blank line it no longer separates.
  const kept = [];
  let dropped = false;
  lines.forEach((line, index) => {
    if (dropIndexes.has(index)) {
      dropped = true;
      return;
    }
    const blank = line.trim() === "";
    if (dropped && blank && kept.length > 0 && kept.at(-1).trim() === "") {
      return;
    }
    if (!blank) {
      dropped = false;
    }
    kept.push(line);
  });
  let body = kept.join("");
  if (trailers(body).length === 0) {
    body = body.replace(/\r?\n\r?\n---------\r?\n(?:[ \t]*\r?\n)*$/, "");
  }
  return body;
}

function compose({ preview, source, authors, captured, queue }) {
  const explicit = captured !== "";
  const sourceTrailers = source.split("\n").filter(Boolean);
  const eligibleEmails = new Set(
    authors
      .split("\n")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const line of sourceTrailers) {
    if (isCredit(line) && !isMachineCredit(line)) {
      eligibleEmails.add(coauthorEmail(line));
    }
  }
  const previewCredits = trailers(preview).filter(isCredit);
  const unsupportedPreviewCredits = previewCredits.filter(
    (line) => !isMachineCredit(line) && !eligibleEmails.has(coauthorEmail(line)),
  );
  const retainedPreviewCredits = previewCredits.filter(
    (line) => !isMachineCredit(line) && eligibleEmails.has(coauthorEmail(line)),
  );
  const previewLines = splitLines(preview);
  const previewMachineLines = machineCreditLines(previewLines);
  // Queue admission cannot override GitHub's message, so a preview that needs
  // editing must stop here instead of merging with the wrong credit.
  if (queue && (unsupportedPreviewCredits.length > 0 || previewMachineLines.size > 0)) {
    throw new Error(
      "Cannot queue a squash message with machine or unsupported preview co-author credit.",
    );
  }
  const machineCreditError = () =>
    new Error(
      "Squash message contains machine co-author credit; remove it from the reviewed --body-file message and keep human contributors.",
    );
  let body;
  if (explicit) {
    // Reviewed bytes are never rewritten, so machine credit anywhere in them,
    // not only in the parsed terminal block, is the operator's to remove.
    body = Buffer.from(JSON.parse(captured).base64, "base64").toString("utf8");
    if (machineCreditLines(splitLines(body)).size > 0) {
      throw machineCreditError();
    }
  } else {
    body = prunePreview(previewLines, unsupportedPreviewCredits, previewMachineLines);
  }
  const original = trailers(body);
  if (original.some(isMachineCredit)) {
    throw machineCreditError();
  }
  const required = [
    ...original,
    ...(explicit ? retainedPreviewCredits : []),
    ...sourceTrailers,
  ].filter((line) => !isMachineCredit(line));
  const missing = [...new Set(required)].filter((line) => !original.includes(line));
  if (queue && missing.length > 0) {
    throw new Error("Cannot queue a squash message that omits required co-author credit.");
  }
  // Keep explicit bytes, including CRLF and trailing blank lines. Insert new
  // credit before that suffix so all parsed trailers remain one terminal block.
  const suffix = explicit ? (body.match(/(?:\r?\n[ \t]*)+$/)?.[0] ?? "") : "\n";
  if (explicit && missing.length === 0) {
    return body;
  }
  body = explicit
    ? body.slice(0, body.length - suffix.length)
    : body.replace(/\n(?:[ \t\r]*\n)*[ \t\r]*$/, "");
  if (missing.length > 0) {
    body += (body ? (original.length ? "\n" : "\n\n") : "") + missing.join("\n");
  }
  body += suffix;
  const final = trailers(body);
  if (required.some((line) => !final.includes(line))) {
    throw new Error(
      "Cannot preserve squash credit: the final message lost a source or preview trailer.",
    );
  }
  const excludedEmails = new Set(unsupportedPreviewCredits.map(coauthorEmail));
  if (
    !explicit &&
    final.some((line) => isCredit(line) && excludedEmails.has(coauthorEmail(line)))
  ) {
    throw new Error("Cannot remove unsupported squash preview credit.");
  }
  return body;
}

try {
  if (process.argv[2] === "read") {
    process.stdout.write(JSON.stringify(snapshot(process.argv[3])));
  } else if (process.argv[2] === "compose") {
    process.stdout.write(compose(JSON.parse(readFileSync(0, "utf8"))));
  } else {
    throw new Error("Expected read or compose.");
  }
} catch (error) {
  console.error(`Cannot prepare merge body: ${error.message}`);
  process.exitCode = 1;
}
