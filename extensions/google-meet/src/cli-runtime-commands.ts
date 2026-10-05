import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  callGoogleMeetRuntime,
  resolveCliMeetingInput as resolveMeetingInput,
  type GoogleMeetCliCommandContext,
} from "./cli-command-context.js";
import {
  callGoogleMeetGateway,
  parseGoogleMeetBrowserTransport,
  parseGoogleMeetMode,
  parseGoogleMeetTransport,
  parsePositiveNumber,
  resolveCliJoinRequest,
  type JoinOptions,
  type RecoverTabOptions,
  type SetupOptions,
  writeLeaveResult,
  writeRecoverCurrentTabResult,
  writeSetupStatus,
  writeStdoutJson,
  writeStdoutLine,
} from "./cli-shared.js";

export function registerGoogleMeetProbeCommands(context: GoogleMeetCliCommandContext): void {
  const { root, callGateway, operationTimeoutMs } = context;

  root
    .command("join")
    .argument("[url]", "Explicit https://meet.google.com/... URL")
    .option("--transport <transport>", "Transport: chrome, chrome-node, or twilio")
    .option("--mode <mode>", "Mode: agent, bidi, or transcribe")
    .option("--message <text>", "Realtime speech to trigger after join")
    .option("--dial-in-number <phone>", "Meet dial-in number for Twilio transport")
    .option("--pin <pin>", "Meet phone PIN; # is appended if omitted")
    .option("--dtmf-sequence <sequence>", "Explicit Twilio DTMF sequence")
    .action(async (url: string | undefined, options: JoinOptions) => {
      const payload = resolveCliJoinRequest(resolveMeetingInput(context.config, url), options);
      const delegated = await callGoogleMeetGateway({
        callGateway,
        method: "googlemeet.join",
        payload,
        timeoutMs: operationTimeoutMs,
      });
      if (delegated.ok) {
        const result = delegated.payload as { session?: unknown };
        writeStdoutJson(result.session ?? delegated.payload);
        return;
      }
      const rt = await context.ensureRuntime();
      const result = await rt.join(payload);
      writeStdoutJson(result.session);
    });

  root
    .command("test-speech")
    .argument("[url]", "Explicit https://meet.google.com/... URL")
    .option("--transport <transport>", "Transport: chrome, chrome-node, or twilio")
    .option("--mode <mode>", "Mode: agent, bidi, or transcribe")
    .option(
      "--message <text>",
      "Realtime speech to trigger",
      "Say exactly: Google Meet speech test complete.",
    )
    .action(async (url: string | undefined, options: JoinOptions) => {
      const payload = {
        url: resolveMeetingInput(context.config, url),
        transport: parseGoogleMeetTransport(options.transport),
        mode: parseGoogleMeetMode(options.mode),
        message: options.message,
      };
      writeStdoutJson(
        await callGoogleMeetRuntime(
          context,
          "googlemeet.testSpeech",
          payload,
          (rt) => rt.testSpeech(payload),
          operationTimeoutMs,
        ),
      );
    });

  root
    .command("test-listen")
    .argument("[url]", "Explicit https://meet.google.com/... URL")
    .option("--transport <transport>", "Transport: chrome or chrome-node")
    .option("--timeout-ms <ms>", "How long to wait for fresh captions/transcript movement")
    .action(async (url: string | undefined, options: JoinOptions) => {
      const payload = {
        url: resolveMeetingInput(context.config, url),
        transport: parseGoogleMeetBrowserTransport(options.transport),
        timeoutMs: parsePositiveNumber(options.timeoutMs, "timeout-ms"),
      };
      writeStdoutJson(
        await callGoogleMeetRuntime(
          context,
          "googlemeet.testListen",
          payload,
          (rt) => rt.testListen(payload),
          operationTimeoutMs,
        ),
      );
    });
}

export function registerGoogleMeetSessionCommands(context: GoogleMeetCliCommandContext): void {
  const { root } = context;

  root
    .command("status")
    .argument("[session-id]", "Meet session ID")
    .option("--json", "Print JSON output", false)
    .action(async (sessionId?: string) => {
      writeStdoutJson(
        await callGoogleMeetRuntime(context, "googlemeet.status", { sessionId }, (rt) =>
          rt.status(sessionId),
        ),
      );
    });

  root
    .command("transcript")
    .description("Print the bounded caption transcript for a Meet session")
    .argument("<session-id>", "Meet session ID")
    .option("--since <index>", "Resume from the previous response's nextIndex")
    .option("--json", "Print JSON output", false)
    .action(async (sessionId: string, options: { since?: string; json?: boolean }) => {
      const sinceIndex = parseStrictNonNegativeInteger(options.since);
      if (options.since !== undefined && sinceIndex === undefined) {
        throw new Error("--since must be a non-negative safe integer");
      }
      const result = await callGoogleMeetRuntime(
        context,
        "googlemeet.transcript",
        { sessionId, ...(sinceIndex === undefined ? {} : { sinceIndex }) },
        (rt) => rt.transcript(sessionId, sinceIndex === undefined ? {} : { sinceIndex }),
      );
      if (!result.found) {
        throw new Error("session not found");
      }
      if (options.json) {
        writeStdoutJson(result);
        return;
      }
      if (result.evicted) {
        writeStdoutLine("# transcript evicted from runtime memory");
      } else if (result.droppedLines) {
        writeStdoutLine("# %d earlier lines dropped by the transcript cap", result.droppedLines);
      }
      for (const line of result.lines ?? []) {
        writeStdoutLine(
          "%s%s%s",
          line.at ? `[${line.at}] ` : "",
          line.speaker ? `${line.speaker}: ` : "",
          line.text,
        );
      }
      writeStdoutLine("# nextIndex: %d", result.nextIndex ?? 0);
    });
}

export function registerGoogleMeetLifecycleCommands(context: GoogleMeetCliCommandContext): void {
  const { root } = context;

  root
    .command("recover-tab")
    .description("Focus and inspect an existing Google Meet tab")
    .argument("[url]", "Optional Meet URL to match")
    .option("--transport <transport>", "Transport to inspect: chrome or chrome-node")
    .option("--json", "Print JSON output", false)
    .action(async (url: string | undefined, options: RecoverTabOptions) => {
      const rt = await context.ensureRuntime();
      const result = await rt.recoverCurrentTab({
        url,
        transport: parseGoogleMeetBrowserTransport(options.transport),
      });
      if (options.json) {
        writeStdoutJson(result);
        return;
      }
      writeRecoverCurrentTabResult(result);
    });

  root
    .command("setup")
    .description("Show Google Meet transport setup status")
    .option("--transport <transport>", "Transport to check: chrome, chrome-node, or twilio")
    .option("--mode <mode>", "Mode to check: agent, bidi, or transcribe")
    .option("--json", "Print JSON output", false)
    .action(async (options: SetupOptions) => {
      const rt = await context.ensureRuntime();
      const status = await rt.setupStatus({
        transport: parseGoogleMeetTransport(options.transport),
        mode: parseGoogleMeetMode(options.mode),
      });
      if (options.json) {
        writeStdoutJson(status);
      } else {
        writeSetupStatus(status);
      }
      if (!status.ok) {
        process.exitCode = 1;
      }
    });

  root
    .command("leave")
    .argument("<session-id>", "Meet session ID")
    .action(async (sessionId: string) => {
      const result = await callGoogleMeetRuntime(context, "googlemeet.leave", { sessionId }, (rt) =>
        rt.leave(sessionId),
      );
      if (!result.found) {
        throw new Error("session not found");
      }
      writeLeaveResult(sessionId, result);
    });

  root
    .command("speak")
    .argument("<session-id>", "Meet session ID")
    .argument("[message]", "Realtime instructions to speak now")
    .action(async (sessionId: string, message?: string) => {
      const result = await callGoogleMeetRuntime(
        context,
        "googlemeet.speak",
        { sessionId, message },
        (rt) => rt.speak(sessionId, message),
      );
      if (!result.found) {
        throw new Error("session not found");
      }
      if (!result.spoken) {
        throw new Error(
          result.session?.chrome?.health?.speechBlockedMessage ??
            "session has no active realtime audio bridge",
        );
      }
      writeStdoutLine("speaking on %s", sessionId);
    });
}
