#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const USAGE =
  "Usage: node gmail-normalize.mjs triage --account ADDRESS --input THREAD.json [--input ...] [--output PATH|-]\n" +
  "       node gmail-normalize.mjs messages --account ADDRESS --input THREAD.json [--input ...] [--output PATH|-]\n\n" +
  "Reads threads gmail-read.mjs saved. ADDRESS is the Gmail address gmail-read.mjs check printed.\n\n" +
  "triage    One JSON line per thread: its newest message, whether the owner wrote in it, a Gmail\n" +
  "          link, and the deterministic prefilter's reason to leave it out (list-mail,\n" +
  "          automated-sender, bulk-category, calendar-notice, spam-or-trash or no-mail), or null.\n" +
  "          A thread the prefilter keeps carries a decision_evaluate input (contractVersion 2),\n" +
  "          to pass unchanged, that asks whether to ingest it and what kind of mail it is.\n" +
  "messages  Normalized chat JSONL for one thread, the format chat-transcript.mjs and\n" +
  "          source-manifest.mjs read. Item IDs are THREAD_ID/MESSAGE_ID. Quoted reply text (lines\n" +
  "          starting with > and the line introducing them) is left out of content. Drafts are left\n" +
  "          out. Each row's sha256 covers the message itself, not its labels or display names, so\n" +
  "          an unchanged message keeps its hash when it is read again. Prints the source key\n" +
  "          gmail:ADDRESS/THREAD_ID and counts to stderr.\n";

/** The rubric a triage row names beside its decision request; change it when the questions change meaning. */
const RUBRIC = "learn-from-mail-1";
// How much of each message the decision request shows, and how many of the newest messages.
const EXCERPT = 300;
const DECISION_MESSAGES = 3;

const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : undefined;

// The messages of one saved thread: Composio's answer, or Gmail's own thread shape.
function messagesOf(data, file) {
  for (const body of [record(data), record(record(data)?.response_data), record(record(data)?.thread)]) {
    if (Array.isArray(body?.messages)) {
      return { body, messages: body.messages.map(record).filter(Boolean) };
    }
  }
  throw new Error(file + " holds no Gmail thread messages");
}

const headerOf = (message, name) => {
  const headers = record(message.payload)?.headers;
  const found = (Array.isArray(headers) ? headers : [])
    .map(record)
    .find((header) => typeof header?.name === "string" && header.name.toLowerCase() === name);
  return typeof found?.value === "string" ? found.value.trim() : undefined;
};

// "Ann <ann@x.com>, bo@y.com" as {name, address} pairs, addresses lower-cased.
function addresses(text) {
  const found = [];
  const pattern = /(?:"([^"]*)"|([^,<>"]*?))\s*<([^<>\s]+@[^<>\s]+)>|([^\s,<>"]+@[^\s,<>"]+)/g;
  for (const match of String(text ?? "").matchAll(pattern)) {
    const address = (match[3] ?? match[4]).toLowerCase();
    const name = (match[1] ?? match[2] ?? "").trim();
    found.push({ name: name && name.toLowerCase() !== address ? name : "", address });
  }
  return found;
}

const decode = (data) => Buffer.from(String(data), "base64url").toString("utf8");

// Text parts of a Gmail payload of one MIME type, in order.
function partText(part, mime) {
  if (!part) {
    return "";
  }
  if (part.mimeType === mime && typeof record(part.body)?.data === "string" && !part.filename) {
    return decode(part.body.data);
  }
  return (Array.isArray(part.parts) ? part.parts : [])
    .map((child) => partText(record(child), mime))
    .filter(Boolean)
    .join("\n");
}

function allParts(part, out = []) {
  if (part) {
    out.push(part);
    for (const child of Array.isArray(part.parts) ? part.parts : []) {
      allParts(record(child), out);
    }
  }
  return out;
}

const fromHtml = (html) =>
  html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

// The message body: plain text first, then Composio's text, then HTML, then the preview.
function bodyOf(message) {
  const payload = record(message.payload);
  const plain = partText(payload, "text/plain");
  if (plain.trim()) {
    return plain;
  }
  if (typeof message.messageText === "string" && message.messageText.trim()) {
    return message.messageText;
  }
  const html = partText(payload, "text/html");
  if (html.trim()) {
    return fromHtml(html);
  }
  return String(record(message.preview)?.body ?? message.snippet ?? "");
}

// Body text without quoted replies: lines starting with ">" and the "On … wrote:" line
// (possibly wrapped over two lines) that introduces them.
function withoutQuotes(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const quoted = (index) => {
    for (let next = index; next < lines.length; next++) {
      if (lines[next].trim()) {
        return /^\s*>/.test(lines[next]);
      }
    }
    return false;
  };
  const kept = [];
  let removed = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*>/.test(line)) {
      removed++;
      continue;
    }
    if (/^\s*On\b.*\bwrote:\s*$/.test(line) && quoted(index + 1)) {
      removed++;
      continue;
    }
    if (/^\s*On\b/.test(line) && /\bwrote:\s*$/.test(lines[index + 1] ?? "") && quoted(index + 2)) {
      removed += 2;
      index++;
      continue;
    }
    kept.push(line);
  }
  return { content: kept.join("\n").replace(/\s+$/, "").replace(/^\n+/, ""), removed };
}

const millis = (message) => {
  if (typeof message.messageTimestamp === "string" && Number.isFinite(Date.parse(message.messageTimestamp))) {
    return Date.parse(message.messageTimestamp);
  }
  const internal = Number(message.internalDate);
  if (Number.isFinite(internal) && internal > 0) {
    return internal;
  }
  const date = Date.parse(headerOf(message, "date") ?? "");
  return Number.isFinite(date) ? date : undefined;
};

const AUTOMATED =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|noresponder|notifications?|notificaciones|notificacoes|mailer-daemon|postmaster|calendar-notification|ne-pas-repondre|keine-antwort|bounces?)(?:[+-].*)?$/i;
const automated = (address) => AUTOMATED.test(address.split("@")[0] ?? "");
const CALENDAR_SUBJECT =
  /^(?:Invitation|Updated invitation|Accepted|Declined|Tentative|Canceled event|Cancelled event|Invitation from Google Calendar)(?: \(.*?\))?:/;
const BULK = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"]);

// One message in the shape both commands read.
function parse(message, threadId, account) {
  const id = String(message.messageId ?? message.id ?? "");
  if (!id) {
    throw new Error("A message of thread " + threadId + " has no ID");
  }
  const at = millis(message);
  if (at === undefined) {
    throw new Error("Message " + id + " has no time");
  }
  const labels = (Array.isArray(message.labelIds) ? message.labelIds : []).filter((label) => typeof label === "string");
  const [from = { name: "", address: "" }] = addresses(message.sender ?? message.from ?? headerOf(message, "from"));
  const to = addresses(message.to ?? headerOf(message, "to")).map((entry) => entry.address);
  const cc = addresses(headerOf(message, "cc")).map((entry) => entry.address);
  const subject = String(message.subject ?? record(message.preview)?.subject ?? headerOf(message, "subject") ?? "").trim();
  const parts = allParts(record(message.payload));
  const calendar =
    parts.some((part) => {
      const type = String(part.mimeType ?? "") + " " + String(headerOf(part, "content-type") ?? "");
      return /text\/calendar/i.test(type) && /\bmethod=\s*"?(?:REQUEST|REPLY|CANCEL|PUBLISH|COUNTER|DECLINECOUNTER|REFRESH|ADD)\b/i.test(type);
    }) || CALENDAR_SUBJECT.test(subject);
  const precedence = (headerOf(message, "precedence") ?? "").toLowerCase();
  const replyTo = addresses(headerOf(message, "reply-to"))[0]?.address;
  const { content, removed } = withoutQuotes(bodyOf(message));
  const owner = from.address === account || labels.includes("SENT");
  return {
    id,
    at,
    labels,
    from,
    to,
    cc,
    subject,
    owner,
    draft: labels.includes("DRAFT"),
    calendar,
    list:
      Boolean(headerOf(message, "list-unsubscribe") || headerOf(message, "list-id")) ||
      ["bulk", "list", "junk"].includes(precedence),
    automated: automated(from.address) || (replyTo !== undefined && automated(replyTo)),
    content,
    removed,
    rfcId: headerOf(message, "message-id"),
    inReplyTo: headerOf(message, "in-reply-to"),
    attachments: parts.flatMap((part) => (part.filename ? [String(part.filename)] : [])),
  };
}

// The threads in the inputs, by thread ID; a message read more than once keeps the later read.
async function readThreads(inputs, account) {
  const threads = new Map();
  for (const file of inputs) {
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file)));
    const { body, messages } = messagesOf(data, file);
    const threadId = String(body.id ?? body.threadId ?? messages[0]?.threadId ?? "");
    if (!/^[0-9a-f]{6,32}$/i.test(threadId)) {
      throw new Error(file + " names no Gmail thread ID");
    }
    const thread = threads.get(threadId) ?? { id: threadId, historyId: undefined, messages: new Map() };
    if (body.historyId !== undefined) {
      thread.historyId = String(body.historyId);
    }
    for (const raw of messages) {
      if (raw.threadId !== undefined && String(raw.threadId) !== threadId) {
        throw new Error(file + " mixes messages of threads " + threadId + " and " + raw.threadId);
      }
      const message = parse(raw, threadId, account);
      thread.messages.set(message.id, message);
    }
    threads.set(threadId, thread);
  }
  return [...threads.values()].map((thread) => ({
    ...thread,
    messages: [...thread.messages.values()]
      .filter((message) => !message.draft)
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
  }));
}

const link = (account, threadId) =>
  "https://mail.google.com/mail/?authuser=" + encodeURIComponent(account) + "#all/" + threadId;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const excerpt = (text) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT ? flat.slice(0, EXCERPT) + "…" : flat;
};
const named = (entry) => (entry.name ? entry.name + " <" + entry.address + ">" : entry.address);

/** The questions every decision request asks, and how the scribe reads the answers. */
const QUESTIONS = {
  ingest: {
    type: "boolean",
    instructions:
      "Should the owner's knowledge base remember something from this email thread? The owner is the mailbox owner; messages marked by_owner are theirs.",
    criteria: {
      true: "The thread holds something worth remembering about the owner's work or relationships: a decision; a commitment, request or open question in either direction (something the owner promised or asked for, or someone waiting on the owner); news about a person, company or project the owner works with; an introduction; or plans and dates agreed with a person.",
      false:
        "The thread is routine or transactional: a receipt, order, shipping or account notice; a newsletter, announcement or marketing; an automated alert or report; a calendar notice without discussion; or a pleasantry with nothing to act on or remember.",
    },
  },
  kind: {
    type: "choice",
    instructions: "What is this email thread mainly about?",
    criteria: {
      commitment: "Someone promises, requests or asks for something, in either direction, or follows up on it",
      decision: "A decision is made, announced or asked for",
      relationship: "An introduction, a new contact, or news about a person",
      project: "News, plans or status of a project, company or deal",
      scheduling: "Arranging a meeting or a time, with nothing else of substance",
      routine: "Receipts, notices, alerts, newsletters and other automated or routine mail",
    },
  },
};

function triage(thread, account) {
  const { messages } = thread;
  const newest = messages.at(-1);
  const all = thread.messages;
  const inbound = messages.filter((message) => !message.owner);
  const ownerWrote = messages.some((message) => message.owner && !message.calendar && message.content.trim());
  const every = (test) => inbound.length > 0 && inbound.every(test);
  const prefilter = !newest
    ? "no-mail"
    : all.every((message) => message.labels.includes("SPAM") || message.labels.includes("TRASH"))
      ? "spam-or-trash"
      : ownerWrote
        ? null
        : !inbound.length
          ? "no-mail"
          : every((message) => message.calendar)
            ? "calendar-notice"
            : every((message) => message.list)
              ? "list-mail"
              : every((message) => message.automated)
                ? "automated-sender"
                : every((message) => message.labels.some((label) => BULK.has(label)))
                  ? "bulk-category"
                  : null;
  const row = {
    thread_id: thread.id,
    ...(thread.historyId ? { history_id: thread.historyId } : {}),
    newest_message_id: newest?.id ?? null,
    newest_at: newest ? new Date(newest.at).toISOString() : null,
    message_count: messages.length,
    subject: messages.find((message) => message.subject)?.subject ?? "",
    owner_wrote: ownerWrote,
    link: link(account, thread.id),
    prefilter,
  };
  if (prefilter === null) {
    const labels = [
      ...new Set(
        messages.flatMap((message) =>
          message.labels.filter((label) => label.startsWith("CATEGORY_") || label === "IMPORTANT" || label === "STARRED"),
        ),
      ),
    ].sort();
    row.rubric = RUBRIC;
    row.decision = {
      contractVersion: 2,
      state: {
        type: "json",
        value: {
          subject: row.subject,
          message_count: messages.length,
          owner_wrote: ownerWrote,
          labels,
          messages: messages.slice(-DECISION_MESSAGES).map((message) => ({
            from: named(message.from),
            by_owner: message.owner,
            owner_in_to: message.to.includes(account),
            date: day(message.at),
            text: excerpt(message.content),
          })),
        },
      },
      questions: QUESTIONS,
    };
  }
  return row;
}

function messageRows(thread, account) {
  const byRfcId = new Map(thread.messages.flatMap((message) => (message.rfcId ? [[message.rfcId, message.id]] : [])));
  const id = (messageId) => thread.id + "/" + messageId;
  const rows = thread.messages.map((message) => {
    const occurredAt = new Date(message.at).toISOString();
    const replyTo = message.inReplyTo && byRfcId.get(message.inReplyTo);
    const payload = {
      account,
      // Not `thread_id`: chat-transcript.mjs reads that as a reply thread within a channel.
      gmail_thread_id: thread.id,
      message_id: message.id,
      author_id: message.from.address || "unknown",
      author_name: message.from.name || message.from.address || "unknown",
      author_bot: message.automated ? 1 : 0,
      by_owner: message.owner ? 1 : 0,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      message_type: message.calendar ? "calendar" : "email",
      created_at: occurredAt,
      edited_at: null,
      deleted_at: null,
      content: message.content,
      quoted_lines_removed: message.removed,
      reply_to_message_id: replyTo ? id(replyTo) : null,
      has_attachments: message.attachments.length ? 1 : 0,
      attachments: message.attachments.join("|") || null,
      labels: message.labels,
    };
    const { author_name: _name, labels: _labels, ...source } = payload;
    const canonical = JSON.stringify(
      Object.fromEntries(Object.entries(source).toSorted(([a], [b]) => (a < b ? -1 : 1))),
    );
    return {
      id: id(message.id),
      occurred_at: occurredAt,
      payload,
      sha256: createHash("sha256").update(canonical).digest("hex"),
    };
  });
  return rows.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id));
}

async function run(argv) {
  const [command, ...rest] = argv;
  if (!command || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const options = new Map();
  const inputs = [];
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || rest[index + 1] === undefined) {
      throw new Error("Arguments must be --name value pairs");
    }
    if (rest[index] === "--input") {
      inputs.push(rest[index + 1]);
    } else {
      options.set(rest[index].slice(2), rest[index + 1]);
    }
  }
  const account = (options.get("account") ?? "").trim().toLowerCase();
  if (!account.includes("@")) {
    throw new Error("--account ADDRESS is required");
  }
  if (!inputs.length) {
    throw new Error("--input is required");
  }
  const threads = await readThreads(inputs, account);
  let lines;
  if (command === "triage") {
    lines = threads.map((thread) => triage(thread, account)).sort((a, b) => a.thread_id.localeCompare(b.thread_id));
  } else if (command === "messages") {
    if (threads.length !== 1) {
      throw new Error("messages normalizes one thread; the inputs hold " + threads.length);
    }
    lines = messageRows(threads[0], account);
    process.stderr.write(
      JSON.stringify({
        provider: "gmail",
        source_key: "gmail:" + account + "/" + threads[0].id,
        thread_id: threads[0].id,
        link: link(account, threads[0].id),
        item_count: lines.length,
        oldest_at: lines[0]?.occurred_at ?? null,
        newest_at: lines.at(-1)?.occurred_at ?? null,
        newest_message_id: lines.at(-1)?.payload.message_id ?? null,
      }) + "\n",
    );
  } else {
    throw new Error("Unknown command " + command + "; see --help");
  }
  const text = lines.map((line) => JSON.stringify(line) + "\n").join("");
  const output = options.get("output") ?? "-";
  if (output === "-") {
    process.stdout.write(text);
  } else {
    await writeFile(output, text);
  }
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
