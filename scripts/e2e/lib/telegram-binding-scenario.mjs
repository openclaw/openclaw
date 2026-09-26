function inputText(content) {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .filter((part) => part?.type === "input_text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
    : "";
}

function currentUserTurn(input) {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index]?.role !== "user") {
      continue;
    }
    let text = inputText(input[index].content);
    // This exact carrier follows its owner; it is not another user turn.
    if (
      text.startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n") &&
      text.endsWith("\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>")
    ) {
      continue;
    }
    if (
      text.includes("[Chat messages since your last reply - for context]") ||
      text.includes("[Recent chat messages - for context]")
    ) {
      const current = "\n[Current message - respond to this]\n";
      const boundary = text.lastIndexOf(current);
      if (boundary < 0) {
        return null;
      }
      text = text.slice(boundary + current.length);
    }
    return { text, tail: input.slice(index + 1) };
  }
  return null;
}

function spawnArguments(run) {
  return {
    task: `TELEGRAM_BINDING_CHILD_${run}. Reply with the child fixture acknowledgment.`,
    taskName: `telegram-binding-${run}`,
    runtime: "subagent",
    thread: true,
    mode: "session",
    cleanup: "keep",
    context: "isolated",
  };
}

function currentSpawnResult(tail, args) {
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const output = tail[index];
    if (output?.type !== "function_call_output" || typeof output.call_id !== "string") {
      continue;
    }
    const call = tail
      .slice(0, index)
      .findLast(
        (item) =>
          item?.type === "function_call" &&
          item.name === "sessions_spawn" &&
          item.call_id === output.call_id,
      );
    try {
      const requested = JSON.parse(call?.arguments ?? "null");
      if (!requested || Object.keys(args).some((key) => requested[key] !== args[key])) {
        continue;
      }
      const receipt = JSON.parse(inputText(output.output));
      return receipt?.status === "accepted" &&
        typeof receipt.childSessionKey === "string" &&
        receipt.childSessionKey.length > 0 &&
        receipt.taskName === args.taskName &&
        receipt.mode === "session"
        ? "accepted"
        : "failed";
    } catch {
      if (call) {
        return "failed";
      }
    }
  }
  return null;
}

// Responses-only fixture selection. Markers correlate synthetic requests; they
// never attest a session's role, binding, or authority. Live proof checks those.
export function createTelegramBindingScenario() {
  const issued = new Set();
  return (body) => {
    const input = Array.isArray(body?.input)
      ? body.input
      : typeof body?.input === "string"
        ? [{ role: "user", content: body.input }]
        : [];
    const turn = currentUserTurn(input);
    if (!turn) {
      return null;
    }
    const markers = [
      ...turn.text.matchAll(
        /\bTELEGRAM_BINDING_(SPAWN|CHILD|BEFORE|AFTER)_([a-z][a-z0-9_-]{0,46})(?![a-zA-Z0-9_-])/gu,
      ),
    ];
    if (markers.length === 0) {
      return null;
    }
    if (markers.length !== 1) {
      return { text: "TELEGRAM_BINDING_FAIL_AMBIGUOUS_MARKER" };
    }
    const [, phase, run] = markers[0];
    if (phase !== "SPAWN") {
      return { text: `TELEGRAM_BINDING_ACK_${phase}_${run}` };
    }
    const args = spawnArguments(run);
    const result = currentSpawnResult(turn.tail, args);
    if (result) {
      const outcome = result === "accepted" && issued.has(run) ? "ACK_PARENT" : "FAIL_SPAWN";
      return { text: `TELEGRAM_BINDING_${outcome}_${run}` };
    }
    if (issued.has(run)) {
      return { text: `TELEGRAM_BINDING_WAITING_${run}` };
    }
    if (
      !Array.isArray(body.tools) ||
      !body.tools.some((tool) => tool?.type === "function" && tool.name === "sessions_spawn")
    ) {
      return { text: `TELEGRAM_BINDING_FAIL_TOOL_NOT_DECLARED_${run}` };
    }
    issued.add(run);
    return { spawn: args };
  };
}
