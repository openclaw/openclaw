import assert from "node:assert/strict";
import {
  buildChannelProgressDraftLine,
  createChannelProgressDraftCompositor,
} from "openclaw/plugin-sdk/channel-outbound";

// Run these unchanged consumer bytes against both the released and candidate packages.
const published: string[] = [];
const entry = {
  streaming: {
    mode: "partial" as const,
    preview: { toolProgress: true, commandText: "raw" as const },
  },
};
const progress = createChannelProgressDraftCompositor({
  entry,
  mode: "partial",
  active: true,
  seed: "legacy-sdk-consumer",
  update: (text) => {
    published.push(text);
    return true;
  },
});

await progress.pushToolEvent({
  toolCallId: "exec-1",
  name: "exec",
  phase: "start",
  args: { command: "ls -alh" },
  detailMode: "raw",
});
assert.match(published.at(-1) ?? "", /ls -alh/u);
const beforeTerminal = published.length;
await progress.pushCommandOutputEvent({ toolCallId: "exec-1", phase: "delta" });
await progress.pushCommandOutputEvent({ toolCallId: "exec-1" });
await progress.pushPatchEvent({ phase: "update", modified: ["pending.ts"] });
await progress.pushPatchEvent({ modified: ["missing-phase.ts"] });
assert.equal(published.length, beforeTerminal);

await progress.pushCommandOutputEvent({
  toolCallId: "exec-1",
  name: "exec",
  phase: "end",
  title: "ls -alh",
  exitCode: 7,
});
assert.match(published.at(-1) ?? "", /exit 7/u);
assert.match(published.at(-1) ?? "", /ls -alh/u);
await progress.pushPatchEvent({
  itemId: "patch-1",
  phase: "end",
  name: "apply_patch",
  summary: "1 modified",
  modified: ["src/example.ts"],
});
assert.match(published.at(-1) ?? "", /1 modified/u);
assert.match(published.at(-1) ?? "", /src\/example\.ts/u);
progress.cancel();

const built: string[] = [];
const custom = createChannelProgressDraftCompositor({
  entry,
  mode: "partial",
  active: true,
  seed: "legacy-sdk-custom-builder",
  buildProgressEventLine: (input, options) => {
    built.push(input.event);
    if (input.event === "tool") {
      assert.deepEqual(input.args, { command: "ls -alh" });
      assert.equal(options?.detailMode, "raw");
    }
    const line = buildChannelProgressDraftLine(input, { ...options, commandText: "raw" });
    return line ? `Custom ${line.text}` : undefined;
  },
  update: (text) => {
    published.push(text);
    return true;
  },
});
await custom.pushToolEvent({
  toolCallId: "custom-exec",
  name: "exec",
  phase: "start",
  args: { command: "ls -alh" },
  detailMode: "raw",
});
assert.match(published.at(-1) ?? "", /Custom .*ls -alh/u);
await custom.pushCommandOutputEvent({ phase: "delta" });
await custom.pushPatchEvent({ phase: "start", summary: "hidden" });
assert.deepEqual(built, ["tool"]);
await custom.pushCommandOutputEvent({
  phase: "end",
  name: "exec",
  title: "custom command",
  exitCode: 3,
});
await custom.pushPatchEvent({
  phase: "end",
  name: "apply_patch",
  summary: "1 added",
  added: ["new.ts"],
});
assert.deepEqual(built, ["tool", "command-output", "patch"]);
assert.match(published.at(-1) ?? "", /Custom .*exit 3/u);
assert.match(published.at(-1) ?? "", /Custom .*1 added/u);
custom.cancel();

console.log("legacy progress consumer: raw tool, command, patch, and custom builder passed");
