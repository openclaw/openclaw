import { afterEach, describe, expect, it } from "vitest";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.policy.js";
import {
  findShellDollarExpansionHazard,
  formatShellDollarExpansionHazard,
} from "./shell-dollar-expansion-guard.js";

// Agent-authored commands of the shapes that corrupted dollar amounts in delivered
// messages ("$900" -> "00", "$1,000" -> ",000"). Phone numbers use the 555 range.
const PRODUCTION_INCIDENTS = {
  callContext:
    'bash scripts/make-call.sh --to "+15555550101" --context "The four leads have not replied or booked. The unit remains listed and vacant at $900. Confirm the owner heard the update."',
  telegramMessage:
    'openclaw message send --channel telegram --account ops --target 1234567890 --message "I checked the October rent at 5:00 PM. The ledger still shows the $1,000 October charge with no posted payment." --json',
  emailSubject:
    'bash scripts/send-email.sh --to agent@example.com --subject "123 Main St - additional $5,000 earnest money receipt needed" --body-file notes/123-main-email.txt',
  smsMessage:
    'bash scripts/send-sms.sh --to "+15555550102" --message "I understand—you\'re disputing the $500 HVAC charge." --task-id "a823af84"',
  estimateEmail:
    './scripts/send-email.sh --to owner@example.com --subject "REVISED: 456 Oak Ave" --message "Planning range is $154,000 low, $204,000 base, $273,000 high." --context "task ed1bed4b"',
};

describe("findShellDollarExpansionHazard", () => {
  it.each(Object.entries(PRODUCTION_INCIDENTS))(
    "flags production incident %s",
    (_name, command) => {
      expect(findShellDollarExpansionHazard(command)).toBeDefined();
    },
  );

  it("reports what the recipient would actually see", () => {
    const hazard = findShellDollarExpansionHazard(PRODUCTION_INCIDENTS.callContext);
    expect(hazard?.token).toBe("$900");
    expect(hazard?.excerpt).toContain("vacant at $900.");
    expect(hazard?.expandedExcerpt).toContain("vacant at 00.");

    const telegram = findShellDollarExpansionHazard(PRODUCTION_INCIDENTS.telegramMessage);
    expect(telegram?.token).toBe("$1,000");
    expect(telegram?.expandedExcerpt).toContain("shows the ,000 October");
  });

  it("flags the bash -lc wrapper form the Codex transcript mirror records", () => {
    const wrapped = `/bin/bash -lc 'bash scripts/send-sms.sh --to "+15555550103" --message "Please submit the remaining $500 by Friday."'`;
    expect(findShellDollarExpansionHazard(wrapped)?.token).toBe("$500");
  });

  it("flags unquoted words and unquoted heredocs", () => {
    expect(findShellDollarExpansionHazard("echo Rent is $900")).toBeDefined();
    expect(
      findShellDollarExpansionHazard("cat > /tmp/msg.txt <<EOF\nRent is $950 per month.\nEOF\n"),
    ).toBeDefined();
    expect(
      findShellDollarExpansionHazard('body=$(cat <<EOF\nDeposit $1,500\nEOF\n)\nsend "$body"'),
    ).toBeDefined();
  });

  it("flags expansions inside command substitution in double quotes", () => {
    expect(findShellDollarExpansionHazard('msg="$(printf "%s" "Rent $900")"')).toBeDefined();
  });

  it.each([
    ["single quotes", "bash scripts/send-sms.sh --message 'Rent is $900 per month'"],
    ["escaped dollar", 'bash scripts/send-sms.sh --message "Rent is \\$900 per month"'],
    ["ANSI-C quoting", "bash scripts/send-sms.sh --message $'Rent is $900\\nThanks'"],
    [
      "quoted heredoc",
      "cat > /tmp/msg.txt <<'EOF'\nRent is $900 per month.\nEOF\nbash scripts/send-sms.sh --message-file /tmp/msg.txt",
    ],
    ["double-quoted heredoc delimiter", 'cat <<"EOF"\nRent $900\nEOF'],
    ["backslash heredoc delimiter", "cat <<\\EOF\nRent $900\nEOF"],
    ["dash heredoc quoted", "cat <<-'EOF'\n\tRent $900\n\tEOF"],
    ["named variables", 'send.sh --message "$MSG" --to "$PHONE" --body "${BODY}"'],
    ["braced positional", 'echo "${1:-default}"'],
    ["awk program in single quotes", "awk '{print $1, $2}' file.txt"],
    ["arithmetic", "echo $(( $1 + 2 ))"],
    ["pid and specials", 'echo "$$ $? $# $@ $*"'],
    ["comment", "ls # costs $5"],
    [
      "single-quoted inside bash -lc wrapper",
      `/bin/bash -lc 'bash scripts/send-sms.sh --message '"'"'Rent is $900'"'"''`,
    ],
    ["bash -c with its own positional args", "bash -c 'echo \"$1\"' _ hello"],
    ["no dollar at all", "ls -la /tmp"],
  ])("does not flag %s", (_name, command) => {
    expect(findShellDollarExpansionHazard(command)).toBeUndefined();
  });

  it("stays out of commands that define functions or set positional parameters", () => {
    expect(findShellDollarExpansionHazard('greet() { echo "hi $1"; }; greet bob')).toBeUndefined();
    expect(findShellDollarExpansionHazard('set -- a b; echo "$1"')).toBeUndefined();
    // Positional parameters are populated on purpose here, so "$1.00" really prints "12.00".
    expect(findShellDollarExpansionHazard(`set -- 12; printf '%s\\n' "$1.00"`)).toBeUndefined();
    expect(
      findShellDollarExpansionHazard('fmt() { printf "%s" "$1.00"; }; fmt 12'),
    ).toBeUndefined();
  });

  it("treats $0 as the shell name unless it reads as money", () => {
    expect(findShellDollarExpansionHazard(`printf '%s\\n' "$0"`)).toBeUndefined();
    expect(findShellDollarExpansionHazard('echo "running $0 now"')).toBeUndefined();
    expect(
      findShellDollarExpansionHazard('send.sh --message "Late fee is $0.50 per day"')?.token,
    ).toBe("$0.50");
  });

  it("honours quoting inside command substitution in an unquoted heredoc", () => {
    expect(
      findShellDollarExpansionHazard("cat <<EOF\nRent: $(printf '%s' '$900')\nEOF\n"),
    ).toBeUndefined();
    expect(
      findShellDollarExpansionHazard('cat <<EOF\nRent: $(printf "%s" "$900")\nEOF\n')?.token,
    ).toBe("$900");
    expect(findShellDollarExpansionHazard("cat <<EOF\nRent: $900\nEOF\n")?.token).toBe("$900");
  });

  it("fails open on input it cannot parse", () => {
    expect(findShellDollarExpansionHazard('echo "unterminated $900')).toBeUndefined();
    expect(findShellDollarExpansionHazard(undefined)).toBeUndefined();
    expect(findShellDollarExpansionHazard(42)).toBeUndefined();
  });

  it("formats an actionable correction", () => {
    const hazard = findShellDollarExpansionHazard(PRODUCTION_INCIDENTS.emailSubject);
    expect(hazard).toBeDefined();
    const message = formatShellDollarExpansionHazard(hazard!);
    expect(message).toContain("`$5,000`");
    expect(message).toContain("additional ,000 earnest");
    expect(message).toContain("Nothing was run");
    expect(message).toContain("<<'EOF'");
  });
});

describe("runBeforeToolCallHook dollar-expansion veto", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_EXEC_DOLLAR_GUARD;
  });

  it.each(["exec", "bash"])(
    "vetoes %s commands that would mangle a dollar amount",
    async (toolName) => {
      const params = { command: PRODUCTION_INCIDENTS.callContext };
      const outcome = await runBeforeToolCallHook({ toolName, params });
      expect(outcome.blocked).toBe(true);
      if (outcome.blocked) {
        expect(outcome.kind).toBe("veto");
        expect(outcome.reason).toContain("vacant at 00.");
      }
    },
  );

  it("allows safely quoted exec commands", async () => {
    const params = { command: "bash scripts/make-call.sh --context 'vacant at $900'" };
    const outcome = await runBeforeToolCallHook({ toolName: "exec", params });
    expect(outcome.blocked).toBe(false);
  });

  it("ignores non-exec tools", async () => {
    const outcome = await runBeforeToolCallHook({
      toolName: "message",
      params: { command: 'echo "$900"', message: "Rent $900" },
    });
    expect(outcome.blocked).toBe(false);
  });

  it("can be disabled with OPENCLAW_EXEC_DOLLAR_GUARD=off", async () => {
    process.env.OPENCLAW_EXEC_DOLLAR_GUARD = "off";
    const outcome = await runBeforeToolCallHook({
      toolName: "exec",
      params: { command: PRODUCTION_INCIDENTS.emailSubject },
    });
    expect(outcome.blocked).toBe(false);
  });
});
