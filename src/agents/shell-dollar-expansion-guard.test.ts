import { afterEach, describe, expect, it } from "vitest";
import { runBeforeToolCallHook } from "./agent-tools.before-tool-call.policy.js";
import {
  findShellDollarExpansionHazard,
  formatShellDollarExpansionHazard,
} from "./shell-dollar-expansion-guard.js";

// Real commands from EDP agent transcripts (Sept/Oct 2026) whose dollar amounts
// were mangled in delivery.
const PRODUCTION_INCIDENTS = {
  pierceCallContext:
    'bash scripts/make-call.sh --to "+17273778284" --context "The four Facebook leads have not replied or booked. The unit remains listed and vacant at $900. Confirm Lisa heard and understood the update."',
  pierceTelegram:
    'openclaw message send --channel telegram --account pierce --target 8568609466 --message "I checked Marquita Wallace\'s October rent at 5:00 PM Central. EDP still shows the $1,000 October charge with no posted payment." --json',
  brettSubject:
    'bash scripts/send-email.sh --to lisa.faw@edprealty.com --subject "1905 S Taft - additional $5,000 earnest money receipt needed" --body-file transactions/1905-s-taft-lisa-email.txt',
  pierceSms:
    'bash scripts/send-sms.sh --to "+18124994636" --message "I understand—you\'re disputing the $500 HVAC charge." --task-id "a823af84"',
  donEmail:
    './scripts/send-email.sh --to andrew@edprealty.com --subject "REVISED: 114 E Tennessee" --message "Planning range is $154,000 low, $204,000 base, $273,000 high." --context "Mission Control ed1bed4b"',
};

describe("findShellDollarExpansionHazard", () => {
  it.each(Object.entries(PRODUCTION_INCIDENTS))(
    "flags production incident %s",
    (_name, command) => {
      expect(findShellDollarExpansionHazard(command)).toBeDefined();
    },
  );

  it("reports what the recipient would actually see", () => {
    const hazard = findShellDollarExpansionHazard(PRODUCTION_INCIDENTS.pierceCallContext);
    expect(hazard?.token).toBe("$900");
    expect(hazard?.excerpt).toContain("vacant at $900.");
    expect(hazard?.expandedExcerpt).toContain("vacant at 00.");

    const telegram = findShellDollarExpansionHazard(PRODUCTION_INCIDENTS.pierceTelegram);
    expect(telegram?.token).toBe("$1,000");
    expect(telegram?.expandedExcerpt).toContain("shows the ,000 October");
  });

  it("flags the bash -lc wrapper form the Codex transcript mirror records", () => {
    const wrapped = `/bin/bash -lc 'bash scripts/send-sms.sh --to "+18126771387" --message "Please submit the remaining $500 by Friday."'`;
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

  it("allows bare $1 when the command defines a function, but still flags money", () => {
    expect(findShellDollarExpansionHazard('greet() { echo "hi $1"; }; greet bob')).toBeUndefined();
    expect(findShellDollarExpansionHazard('set -- a b; echo "$1"')).toBeUndefined();
    expect(
      findShellDollarExpansionHazard('f() { echo "$1"; }; f "Rent is $900 per month"'),
    ).toBeDefined();
  });

  it("fails open on input it cannot parse", () => {
    expect(findShellDollarExpansionHazard('echo "unterminated $900')).toBeUndefined();
    expect(findShellDollarExpansionHazard(undefined)).toBeUndefined();
    expect(findShellDollarExpansionHazard(42)).toBeUndefined();
  });

  it("formats an actionable correction", () => {
    const hazard = findShellDollarExpansionHazard(PRODUCTION_INCIDENTS.brettSubject);
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
      const params = { command: PRODUCTION_INCIDENTS.pierceCallContext };
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
      params: { command: PRODUCTION_INCIDENTS.brettSubject },
    });
    expect(outcome.blocked).toBe(false);
  });
});
