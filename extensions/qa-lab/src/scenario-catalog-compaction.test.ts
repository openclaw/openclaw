import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { readFlowAssertExpression, requireFlowScenario } from "./scenario-catalog.test-utils.js";

function expectContains(text: string, ...needles: string[]) {
  for (const needle of needles) {
    expect(text).toContain(needle);
  }
}

function expectIncreasing(indices: number[]) {
  expect(indices[0]).toBeGreaterThanOrEqual(0);
  for (let index = 1; index < indices.length; index += 1) {
    expect(indices[index]).toBeGreaterThan(indices[index - 1]!);
  }
}

describe("qa compaction scenario catalog", () => {
  it.each([
    { retained: [12, 13, 14, 15], pass: true },
    { retained: [10, 11, 12, 13, 14, 15], pass: false },
    { retained: [12, 14, 15], pass: false },
    { retained: [], pass: false },
  ])("recognizes complete retained blocks: $retained", ({ retained, pass }) => {
    const scenario = requireFlowScenario(readQaScenarioById("compaction-retry-mutating-tool"));
    const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
    const config = scenario.execution.config;
    const evaluate = (expression: string, scope: object = {}) =>
      runInNewContext(expression, { config, now: 0, ...scope });
    const seed = actions.find(
      (action) => (action as { call?: string }).call === "seedQaSessionTranscript",
    ) as { args: [unknown, { messages: { expr: string } }] };
    const messages = evaluate(seed.args[1].messages.expr) as { text: string }[];
    const block = (index: number) =>
      messages.find((message) =>
        message.text.includes(
          `post-marker historical user block ${String(index).padStart(2, "0")}`,
        ),
      )!.text;
    const overflowRequest = {
      cursor: 1,
      allInputText: messages.map((message) => message.text).join("\n"),
    };
    const writeRequest = {
      cursor: 2,
      allInputText: [
        "Recent turns preserved verbatim:",
        ...[9, 10, 11].map((index) => block(index).slice(0, 600)),
        ...retained.map(block),
      ].join("\n"),
    };
    const evidence = actions.find(
      (action) => (action as { set?: string }).set === "requestEvidence",
    ) as { value: { expr: string } };
    const [overflowEvidence, writeEvidence] = evaluate(evidence.value.expr, {
      scenarioRequests: [overflowRequest, writeRequest],
    }) as unknown[];
    const pruningAssertions = actions
      .map(readFlowAssertExpression)
      .filter((expression) =>
        ["tailBlocks", "includes(config.bulkyMarker)"].some((needle) =>
          expression.includes(needle),
        ),
      );
    expect(pruningAssertions).toHaveLength(2);
    expect(
      pruningAssertions.every((expression) =>
        evaluate(expression, { overflowRequest, writeRequest, overflowEvidence, writeEvidence }),
      ),
    ).toBe(pass);
  });

  it.each([
    ["empty-response", "EMPTY", "empty-output-once"],
    ["reasoning-only", "REASONING", "reasoning-only-output-once"],
  ])("keeps %s recovery on the OpenClaw compaction owner", (variant, summary, faultMode) => {
    const id = `compaction-${variant}-recovery`;
    const coverage = `session-memory.${id}`;
    const summaryMarker = `QA-COMPACTION-${summary}-RECOVERED-SUMMARY`;
    const scenario = requireFlowScenario(readQaScenarioById(id));
    const flow = JSON.stringify(scenario.execution.flow);
    const serializedScenario = JSON.stringify(scenario);

    expect(scenario.runtimePairLane).toBeUndefined();
    expect(scenario.coverage?.primary).toEqual([coverage]);
    expect(scenario.coverage?.secondary ?? []).toEqual([]);
    expect(scenario.gatewayConfigPatch).toMatchObject({
      agents: { defaults: { compaction: { mode: "default" } } },
    });
    expect(flow).toContain("env.runtimeId === 'openclaw'");
    expect(flow).toContain("initialRequests[0].errorCode === 'context_length_exceeded'");
    expect(flow).toContain("initialRequests.length === 2");
    expect(flow).toContain("compactionSummaryRequests.length === 3");
    expectContains(
      flow,
      `compactionSummaryRequests[0].compactionSummaryFaultMode === config.faultMode`,
      "compactionSummaryRequests[0].cursor < compactionSummaryRequests[1].cursor",
      "scenarioRequests.every((request) => request.model === scenarioRequests[0].model)",
    );
    expect(flow).toContain("compactionSummaryRequests[1].compactionSummaryFaultMode === 'none'");

    expect(flow).toContain("transcript.compactionSummaries.length === 1");
    expect(flow).toContain("transcript.compactionSummaries[0].includes(config.summaryMarker)");
    expect(flow).toContain("String(transcript.finalText ?? '').trim() === config.finalMarker");
    expect(flow).toContain("sessionEntry?.compactionCount === 1");
    expect(flow).toContain("request.requestKind === 'tool-continuation'");
    expect(flow).toContain("finalOutbound.length === 1");
    expect(serializedScenario).toContain(faultMode);
    expect(serializedScenario).toContain(summaryMarker);
    expect(serializedScenario).not.toContain("codex");
  });

  it("assigns compaction retry and pruning to OpenClaw with an early Codex gap", () => {
    const scenario = requireFlowScenario(readQaScenarioById("compaction-retry-mutating-tool"));
    const flow = JSON.stringify(scenario.execution.flow);
    const actions = scenario.execution.flow?.steps[0]?.actions ?? [];
    const setExpr = (name: string) =>
      (
        actions.find((candidate) => (candidate as { set?: string }).set === name) as
          | { value?: { expr?: string } }
          | undefined
      )?.value?.expr ?? "";
    const assertExpr = (needle: string) =>
      actions.map(readFlowAssertExpression).find((expression) => expression.includes(needle)) ?? "";
    const continuations = setExpr("postWriteContinuations");
    const callId = setExpr("writeTranscriptToolCallId");
    const summaries = setExpr("compactionSummaryRequests");
    const sessionId = "seeded-transcript";
    const allInputText = "Compaction retry mutating tool check QA-COMPACTION-DURABLE-MARKER";
    const makeRequest = <T extends object>(cursor: number, fields: T) => ({
      cursor,
      sessionId,
      allInputText,
      ...fields,
    });
    const overflow = makeRequest(1, {
      requestKind: "agent-initial",
      outcome: "error",
      errorCode: "context_length_exceeded",
    });
    const write = makeRequest(2, { plannedToolName: "write" });
    const failedWrite = { ...write, cursor: 3, outcome: "error", toolOutput: "failed" };
    const continuation = makeRequest(4, { requestKind: "tool-continuation" });
    const failedContinuation = {
      ...continuation,
      cursor: 5,
      outcome: "error",
      toolOutputStructuredError: true,
    };
    const foreign = <T extends object>(request: T) => ({
      ...request,
      sessionId: `${sessionId}-other`,
      allInputText: `${allInputText} ${sessionId}`,
    });
    const scope = {
      sessionId,
      config: scenario.execution.config,
      overflowRequest: overflow,
      writeRequest: write,
      scenarioRequests: [
        overflow,
        foreign(overflow),
        { ...overflow, outcome: "success" },
        { ...overflow, errorCode: "other" },
        write,
        failedWrite,
        foreign(write),
        { ...write, cursor: 0 },
        { ...write, plannedToolName: "read" },
        { ...write, allInputText: "QA-COMPACTION-DURABLE-MARKER" },
        { ...write, allInputText: "Compaction retry mutating tool check" },
        continuation,
        failedContinuation,
        foreign(continuation),
        { ...continuation, cursor: 1 },
        { ...continuation, requestKind: "agent-initial" },
      ],
    };
    expect(runInNewContext(setExpr("overflowRequests"), scope)).toEqual([overflow]);
    expect(runInNewContext(setExpr("writeRequests"), scope)).toEqual([write, failedWrite]);
    expect(runInNewContext(continuations, scope)).toEqual([continuation, failedContinuation]);
    expectIncreasing([
      ...[
        "continuationChain.valid === true",
        "terminalContinuations.length === 1",
        "new Set([writeRequest.plannedToolCallId",
        "continuationChain.waits.length === 0",
        "terminalContinuations[0].codeModeExecSurface === 'native'",
      ].map((needle) =>
        actions.findIndex((action) => readFlowAssertExpression(action).includes(needle)),
      ),
      actions.findIndex(
        (action) =>
          (action as { call?: string }).call === "waitForCondition" &&
          (action as { saveAs?: string }).saveAs === "outbound",
      ),
    ]);
    const stableCell = assertExpr("continuationChain.waits.length === 0");
    const terminal = assertExpr("terminalContinuations[0].codeModeExecSurface === 'native'");
    const summaryCheck = assertExpr("compactionSummaryRequests.some");
    const retryCheck = assertExpr("Previous summary failed quality checks");
    const snapshot = assertExpr("Number.isInteger(sessionEntry?.compactionCount)");
    const knownGap =
      "known-harness-gap compaction-retry-mutating-tool: provider-error recovery does not invoke Codex native compaction; native token-threshold compaction needs a separate scenario.";

    expect(scenario.runtimePairLane).toBe("core");
    expect(scenario.coverage?.primary).toEqual([
      "session-memory.compaction",
      "session-memory.compaction-retry-policy",
      "session-memory.pruning",
    ]);
    expect(scenario.coverage?.secondary ?? []).toEqual([]);
    const conditional = (actions[0] as { if: Record<string, unknown> }).if;
    expect(conditional.expr).toBe("env.runtimeId === 'codex'");
    expect(conditional["then"]).toMatchObject([
      { call: "qaImport", args: ["./errors.js"], saveAs: "qaErrors" },
      { throw: { expr: expect.stringContaining(`QaSuiteScenarioSkipError('${knownGap}')`) } },
    ]);
    expect(readFlowAssertExpression(actions[1])).toContain("env.runtimeId === 'openclaw'");

    const knownGapIndex = flow.indexOf(knownGap);
    const gatewayWorkIndex = flow.indexOf('"call":"waitForGatewayHealthy"');
    expect(knownGapIndex).toBeGreaterThanOrEqual(0);
    expect(knownGapIndex).toBeLessThan(gatewayWorkIndex);
    expectContains(
      flow,
      "writeRequest.plannedWireToolName === undefined || writeRequest.plannedWireToolName === 'exec'",
      'writeWireToolName","value":{"expr":"writeRequest.plannedWireToolName ?? writeRequest.plannedToolName',
      "event.toolCallId === writeTranscriptToolCallId && event.name === writeWireToolName",
      "continuationChain.requests.every((request, index) => request === postWriteContinuations[index])",
      "continuationChain.requests.length === continuationChain.waits.length + 1",
      "writeRequest.rawByteLength < config.overflowThresholdBytes && writeRequest.rawByteLength < overflowRequest.rawByteLength",
    );
    expect(flow).toContain("outbound.text === config.finalMarker");
    expect(flow).toContain("overflowRequests.length === 1");
    expect(flow).toContain("overflowRequest.rawByteLength > config.overflowThresholdBytes");
    expect(flow).toContain("writeRequests.length === 1");
    expectContains(
      assertExpr("writeRequest.requestKind"),
      "writeRequest.outcome === 'success' && !writeRequest.toolOutput",
      "writeRequest.plannedToolArgs?.path === config.outputFile && writeRequest.plannedToolArgs?.content === config.expectedFileContent",
      "typeof writeRequest.plannedToolCallId === 'string' && writeRequest.plannedToolCallId.length > 0",
    );

    expect(flow).toContain("successfulWriteTranscriptEvents.length === 1");
    expect(flow).toContain("transcript.successfulToolCallCounts[writeWireToolName] === 1");
    expectContains(
      assertExpr("continuationChain.valid"),
      "continuationChain.requests.length === postWriteContinuations.length",
      "request.outcome === 'success' && request.toolOutputStructuredError !== true",
    );
    expect(assertExpr("terminalContinuations.length === 1")).toContain(
      "terminalContinuations[0] === continuationChain.terminal && String(terminalContinuations[0].toolOutput ?? '').trim().length > 0 && terminalContinuations[0].toolOutputStructuredError !== true",
    );
    expect(flow).toContain("{ role: 'assistant', text: config.historyMarker");

    expect(scenario.execution.retryCount).toBe(0);
    expect(flow).not.toContain('"transcriptToolName":"write"');
    expect(flow).not.toContain('"requireSuccessfulTranscriptToolResult":true');
    expect(flow).not.toContain("compactionSummaryRequests.length === 1");
    expect(flow).not.toContain("{ role: 'assistant', text: config.bulkyMarker");
    expect(flow).not.toContain("JSON.stringify(overflowRequest)");

    for (const [plannedToolItemId, expected] of [
      ["item", "call|item"],
      ["", "call"],
      [undefined, "call"],
    ]) {
      expect(
        runInNewContext(callId, { writeRequest: { plannedToolCallId: "call", plannedToolItemId } }),
      ).toBe(expected);
    }

    expect(stableCell).toContain("continuationChain.waits.length === 0 ||");
    expect(stableCell).toContain("typeof request.plannedToolArgs?.cell_id === 'string'");
    expect(stableCell).toContain(
      "new Set(continuationChain.waits.map((request) => request.plannedToolArgs.cell_id)).size === 1",
    );

    expect(terminal).toContain("writeWireToolName !== 'exec'");
    expect(terminal).toContain("startsWith('Script completed\\n')");
    expect(terminal).toContain("JSON.parse(String(terminalContinuations[0].toolOutput ?? ''))");
    expect(terminal).toContain("parsed !== null");
    expect(terminal).toContain("typeof parsed === 'object'");
    expect(terminal).toContain("!Array.isArray(parsed)");
    expect(terminal).toContain("parsed.status === 'completed'");
    expectIncreasing([
      ...["native", "guest"].map((surface) =>
        terminal.indexOf(`terminalContinuations[0].codeModeExecSurface === '${surface}'`),
      ),
      terminal.lastIndexOf(": false"),
    ]);
    expect(summaries).toContain("request.requestKind === 'compaction-summary'");
    expectContains(
      summaryCheck,
      "compactionSummaryRequests.some((request) => request.cursor > overflowRequest.cursor && request.cursor < writeRequest.cursor)",
      "compactionSummaryRequests.every((request) => request.outcome === 'success' && request.plannedToolName === undefined && request.toolOutputStructuredError !== true)",
    );
    expect(retryCheck).toContain(
      "!String(request.allInputText ?? '').includes('Previous summary failed quality checks')",
    );
    expectContains(
      snapshot,
      "Number.isInteger(sessionEntry?.compactionCount) && sessionEntry.compactionCount >= 1",
      "Number.isFinite(sessionEntry?.totalTokens) && sessionEntry?.totalTokensFresh === true",
    );
    expect(snapshot).not.toContain("compactionCount === 1");

    const requestEvidenceIndex = flow.indexOf('"set":"scenarioRequests"');
    expect(requestEvidenceIndex).toBeGreaterThanOrEqual(0);
    expect(requestEvidenceIndex).toBeLessThan(flow.indexOf('"call":"fs.readFile"'));
  });
});
