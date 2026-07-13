// Slack progress-chrome detection and reaction mapping for tool/progress payloads.
// Kept private to the Slack extension so send/replies stay under the LOC ratchet.

const PROGRESS_CHROME_REACTION_BY_EMOJI = new Map<string, string>([
  ["hammer_and_wrench", "hammer_and_wrench"],
  ["writing_hand", "writing_hand"],
  ["email", "email"],
  ["mag", "mag"],
  ["floppy_disk", "floppy_disk"],
]);

const PROGRESS_CHROME_REACTION_BY_UNICODE_EMOJI = new Map<string, string>([
  ["🛠", "hammer_and_wrench"],
  ["🛠️", "hammer_and_wrench"],
  ["🩹", "adhesive_bandage"],
  ["✍", "writing_hand"],
  ["✍️", "writing_hand"],
  ["📧", "email"],
  ["📖", "open_book"],
  ["🔎", "mag"],
  ["🔍", "mag"],
  ["💾", "floppy_disk"],
]);

function hasSlackPlatformError(err: unknown, code: string): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const data = (err as { data?: { error?: unknown } }).data;
  return data?.error === code;
}

function detectSlackProgressChromeReaction(
  text: string,
  opts: { progressChrome?: boolean } = {},
): string | undefined {
  const trimmed = text.trim();
  const shortcodeMatch = /^:([a-z0-9_+-]+):\s+([\s\S]*)$/i.exec(trimmed);
  const unicodeMatch = /^(\p{Extended_Pictographic}\ufe0f?)\s+([\s\S]*)$/u.exec(trimmed);
  const reaction = shortcodeMatch
    ? PROGRESS_CHROME_REACTION_BY_EMOJI.get(shortcodeMatch[1]?.toLowerCase() ?? "")
    : unicodeMatch
      ? PROGRESS_CHROME_REACTION_BY_UNICODE_EMOJI.get(unicodeMatch[1] ?? "")
      : undefined;
  const body = (shortcodeMatch?.[2] ?? unicodeMatch?.[2] ?? "").trim();
  if (!reaction || !body) {
    return undefined;
  }
  if (!opts.progressChrome) {
    return undefined;
  }

  const hasStandaloneBacktickCommand = /^`[^`\n]{1,240}`$/.test(body);
  const progressLabelMatch =
    /^(write|read|edit|update|message|email|search|save|print|run|exec|bash|cmd|apply\s+patch|web\s+search)(?:$|\s*:\s*|\s+`|\s+)([\s\S]*)$/i.exec(
      body,
    );
  const progressLabelRemainder = progressLabelMatch?.[2]?.trim() ?? "";
  const hasMachineProgressRemainder =
    !progressLabelRemainder ||
    /`[^`\n]{1,240}`/.test(progressLabelRemainder) ||
    /"[^"\n]{1,240}"/.test(progressLabelRemainder) ||
    /[\w.-]+\.(?:css|html|js|json|md|mjs|png|sh|ts|tsx|txt|ya?ml)(?=[\s,)}\]]|$)/i.test(
      progressLabelRemainder,
    ) ||
    /(?:^|\s)(?:[~./]?[\w.-]+\/[\w./-]+|[\w.-]+\.(?:css|html|js|json|md|mjs|png|sh|ts|tsx|txt|ya?ml)|[#@][\w.-]+|[A-Z0-9_]+=[^\s]+)(?:\s|$)/i.test(
      progressLabelRemainder,
    );
  const progressLabel = progressLabelMatch?.[1]?.toLowerCase().replace(/\s+/g, " ") ?? "";
  const isPlainCommandProgressRemainder =
    /^(exec|run|bash|cmd)$/.test(progressLabel) &&
    Boolean(progressLabelRemainder) &&
    !/[.!?](?:\s|$)/.test(progressLabelRemainder) &&
    (progressLabelRemainder.match(/[A-Za-z0-9_/-]+/g) ?? []).length <= 8;
  const hasProgressLabel = Boolean(
    progressLabelMatch && (hasMachineProgressRemainder || isPlainCommandProgressRemainder),
  );
  const lineCount = body.split(/\r?\n/).filter((line) => line.trim()).length;
  const hasSentencePunctuation = /[.!?](?:\s|$)/.test(body);
  const wordCount = (body.match(/[A-Za-z0-9_/-]+/g) ?? []).length;

  if (
    (hasStandaloneBacktickCommand || hasProgressLabel) &&
    lineCount <= 2 &&
    !hasSentencePunctuation
  ) {
    return reaction;
  }
  if (
    hasStandaloneBacktickCommand &&
    wordCount <= 12 &&
    lineCount <= 3 &&
    !hasSentencePunctuation
  ) {
    return reaction;
  }
  return undefined;
}

type SlackProgressChromeSuppressInput = {
  client: {
    reactions: {
      add: (args: { channel: string; timestamp: string; name: string }) => Promise<unknown>;
    };
  };
  channelId: string;
  text: string;
  threadTs?: string;
  progressChrome?: true | undefined;
  progressChromeReaction?: string | undefined;
  logVerbose: (message: string) => void;
};

type SlackProgressChromeSuppressDecision =
  | { suppress: false }
  | {
      suppress: true;
      reactionAttempted: boolean;
    };

/** Detect/react/suppress progress-chrome text before chat.postMessage. */
export async function maybeSuppressSlackProgressChrome(
  input: SlackProgressChromeSuppressInput,
): Promise<SlackProgressChromeSuppressDecision> {
  const progressReaction =
    input.progressChrome === true
      ? input.progressChromeReaction ||
        detectSlackProgressChromeReaction(input.text, { progressChrome: true })
      : detectSlackProgressChromeReaction(input.text, { progressChrome: false });
  if (input.progressChrome !== true && !progressReaction) {
    return { suppress: false };
  }
  if (progressReaction && input.threadTs) {
    try {
      await input.client.reactions.add({
        channel: input.channelId,
        timestamp: input.threadTs,
        name: progressReaction,
      });
      input.logVerbose("slack send: converted progress chrome payload to reaction");
    } catch (err) {
      input.logVerbose(
        hasSlackPlatformError(err, "already_reacted")
          ? "slack send: progress chrome reaction already present"
          : "slack send: suppressed progress chrome payload after reaction failure",
      );
    }
  } else if (input.progressChrome === true && progressReaction && !input.threadTs) {
    input.logVerbose("slack send: suppressed progress chrome payload without reaction target");
  } else if (input.progressChrome === true && !progressReaction) {
    input.logVerbose(
      input.threadTs
        ? "slack send: suppressed unmapped typed progress chrome payload"
        : "slack send: suppressed progress chrome payload without reaction target",
    );
  } else if (progressReaction && !input.threadTs) {
    input.logVerbose("slack send: suppressed progress chrome payload without reaction target");
  }
  return { suppress: true, reactionAttempted: Boolean(progressReaction && input.threadTs) };
}

export function isSuppressedSlackSendResult(result: { suppressed?: true } | undefined): boolean {
  return result?.suppressed === true;
}
