import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import "./env-p2fClQGo.js";
import "./manifest-registry-BVVAY7EK.js";
import "./runtime-guard-C3Y1NNt6.js";
import "./min-host-version-CBCneeMT.js";
import "./io-BqN-ccJq.js";
import "./safe-text-BZlsWMQt.js";
import "./call-CQ3XcxPH.js";
import "./loader-1TRSsxsu.js";
import "./hook-runner-global-CNL1LAdZ.js";
import "./runtime-BhHu0jrd.js";
import "./facade-runtime-ClqNqXUH.js";
import { i as toAcpRuntimeError } from "./errors-Bl372wkS.js";
import "./provider-discovery-D9Ghbob_.js";
import "./failover-matches-Deflawcb.js";
import "./bundled-capability-runtime-DXL4sXoh.js";
import "./registry-B49KpvF5.js";
import "./web-provider-public-artifacts.explicit-rw0HpAiU.js";
import "./deliver-CCQW_Dx5.js";
import "./system-events-BjJbC-Fg.js";
import "./live-auth-keys-By6U22zF.js";
import "./task-registry-DUIbXSGA.js";
import "./manager-Ch6fn0QF.js";
import "./runtime-taskflow-CCggUHvN.js";
import { t as buildCommandContext } from "./commands-context-DZ-tD_zh.js";
import { t as parseInlineDirectives } from "./directive-handling.parse-pAUeorSf.js";
import "./png-encode-C6MdvqNV.js";
import { t as globalExpect } from "./test.DNmyFkvJ-BSTQY5ec.js";
import "./hooks.test-helpers-tgy46D8M.js";
import "./inbound-testkit-HOTQ4xBE.js";
import "./plugin-setup-wizard-DtlmTIrs.js";
import "./runtime-sidecar-paths-Dz6hfJkY.js";
import "./provider-wizard-l7Mfpl34.js";
import "./provider-auth-choice.runtime-DOuMw2aZ.js";
import "./frozen-time-DJCe3LCq.js";
import "./commands-acp-B4b63uPJ.js";
import { randomUUID } from "node:crypto";
//#region src/plugins/provider-runtime.test-support.ts
const openaiCodexCatalogEntries = [
	{
		provider: "openai",
		id: "gpt-5.2",
		name: "GPT-5.2"
	},
	{
		provider: "openai",
		id: "gpt-5.2-pro",
		name: "GPT-5.2 Pro"
	},
	{
		provider: "openai",
		id: "gpt-5-mini",
		name: "GPT-5 mini"
	},
	{
		provider: "openai",
		id: "gpt-5-nano",
		name: "GPT-5 nano"
	},
	{
		provider: "openai-codex",
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex"
	}
];
const expectedAugmentedOpenaiCodexCatalogEntries = [
	{
		provider: "openai",
		id: "gpt-5.4",
		name: "gpt-5.4"
	},
	{
		provider: "openai",
		id: "gpt-5.4-pro",
		name: "gpt-5.4-pro"
	},
	{
		provider: "openai",
		id: "gpt-5.4-mini",
		name: "gpt-5.4-mini"
	},
	{
		provider: "openai",
		id: "gpt-5.4-nano",
		name: "gpt-5.4-nano"
	},
	{
		provider: "openai-codex",
		id: "gpt-5.4",
		name: "gpt-5.4"
	},
	{
		provider: "openai-codex",
		id: "gpt-5.4-pro",
		name: "gpt-5.4-pro"
	},
	{
		provider: "openai-codex",
		id: "gpt-5.4-mini",
		name: "gpt-5.4-mini"
	}
];
const expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55 = [
	{
		provider: "openai",
		id: "gpt-5.5-pro",
		name: "gpt-5.5-pro"
	},
	...expectedAugmentedOpenaiCodexCatalogEntries.slice(0, 4),
	{
		provider: "openai-codex",
		id: "gpt-5.5-pro",
		name: "gpt-5.5-pro"
	},
	...expectedAugmentedOpenaiCodexCatalogEntries.slice(4)
];
const expectedOpenaiPluginCodexCatalogEntriesWithGpt55 = expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55;
function expectCodexMissingAuthHint(buildProviderMissingAuthMessageWithPlugin, expectedModel = "openai/gpt-5.5") {
	globalExpect(buildProviderMissingAuthMessageWithPlugin({
		provider: "openai",
		env: process.env,
		context: {
			env: process.env,
			provider: "openai",
			listProfileIds: (providerId) => providerId === "openai-codex" ? ["p1"] : []
		}
	})).toContain(expectedModel);
}
async function expectAugmentedCodexCatalog(augmentModelCatalogWithProviderPlugins, expectedEntries = expectedAugmentedOpenaiCodexCatalogEntries) {
	const result = await augmentModelCatalogWithProviderPlugins({
		env: process.env,
		context: {
			env: process.env,
			entries: openaiCodexCatalogEntries
		}
	});
	globalExpect(result).toHaveLength(expectedEntries.length);
	for (const entry of expectedEntries) globalExpect(result).toContainEqual(globalExpect.objectContaining(entry));
}
//#endregion
//#region src/acp/runtime/adapter-contract.testkit.ts
async function runAcpRuntimeAdapterContract(params) {
	const runtime = await params.createRuntime();
	const sessionKey = `agent:${params.agentId ?? "codex"}:acp:contract-${randomUUID()}`;
	const agent = params.agentId ?? "codex";
	const handle = await runtime.ensureSession({
		sessionKey,
		agent,
		mode: "persistent"
	});
	globalExpect(handle.sessionKey).toBe(sessionKey);
	globalExpect(handle.backend.trim()).not.toHaveLength(0);
	globalExpect(handle.runtimeSessionName.trim()).not.toHaveLength(0);
	const successEvents = [];
	for await (const event of runtime.runTurn({
		handle,
		text: params.successPrompt ?? "contract-success",
		mode: "prompt",
		requestId: `contract-success-${randomUUID()}`
	})) successEvents.push(event);
	globalExpect(successEvents.some((event) => event.type === "done" || event.type === "text_delta" || event.type === "status" || event.type === "tool_call")).toBe(true);
	globalExpect(successEvents.some((event) => event.type === "done")).toBe(true);
	await params.assertSuccessEvents?.(successEvents);
	if (params.includeControlChecks ?? true) {
		if (runtime.getStatus) {
			const status = await runtime.getStatus({ handle });
			globalExpect(status).toBeDefined();
			globalExpect(typeof status).toBe("object");
		}
		if (runtime.setMode) await runtime.setMode({
			handle,
			mode: "contract"
		});
		if (runtime.setConfigOption) await runtime.setConfigOption({
			handle,
			key: "contract_key",
			value: "contract_value"
		});
	}
	let errorThrown = null;
	const errorEvents = [];
	const errorPrompt = normalizeOptionalString(params.errorPrompt);
	if (errorPrompt) {
		try {
			for await (const event of runtime.runTurn({
				handle,
				text: errorPrompt,
				mode: "prompt",
				requestId: `contract-error-${randomUUID()}`
			})) errorEvents.push(event);
		} catch (error) {
			errorThrown = error;
		}
		const sawErrorEvent = errorEvents.some((event) => event.type === "error");
		globalExpect(Boolean(errorThrown) || sawErrorEvent).toBe(true);
		if (errorThrown) {
			const acpError = toAcpRuntimeError({
				error: errorThrown,
				fallbackCode: "ACP_TURN_FAILED",
				fallbackMessage: "ACP runtime contract expected an error turn failure."
			});
			globalExpect(acpError.code.length).toBeGreaterThan(0);
			globalExpect(acpError.message.length).toBeGreaterThan(0);
		}
	}
	await params.assertErrorOutcome?.({
		events: errorEvents,
		thrown: errorThrown
	});
	await runtime.cancel({
		handle,
		reason: "contract-cancel"
	});
	await runtime.close({
		handle,
		reason: "contract-close"
	});
}
//#endregion
//#region src/auto-reply/reply/commands.test-harness.ts
function buildCommandTestParams$1(commandBody, cfg, ctxOverrides, options) {
	const ctx = {
		Body: commandBody,
		CommandBody: commandBody,
		CommandSource: "text",
		CommandAuthorized: true,
		Provider: "whatsapp",
		Surface: "whatsapp",
		...ctxOverrides
	};
	return {
		ctx,
		cfg,
		command: buildCommandContext({
			ctx,
			cfg,
			isGroup: false,
			triggerBodyNormalized: commandBody.trim(),
			commandAuthorized: true
		}),
		directives: parseInlineDirectives(commandBody),
		elevated: {
			enabled: true,
			allowed: true,
			failures: []
		},
		sessionKey: "agent:main:main",
		workspaceDir: options?.workspaceDir ?? "/tmp",
		defaultGroupActivation: () => "mention",
		resolvedVerboseLevel: "off",
		resolvedReasoningLevel: "off",
		resolveDefaultThinkingLevel: async () => void 0,
		provider: "whatsapp",
		model: "test-model",
		contextTokens: 0,
		isGroup: false
	};
}
//#endregion
//#region src/auto-reply/reply/commands-spawn.test-harness.ts
function buildCommandTestParams(commandBody, cfg, ctxOverrides) {
	return buildCommandTestParams$1(commandBody, cfg, ctxOverrides);
}
//#endregion
export { expectedAugmentedOpenaiCodexCatalogEntriesWithGpt55 as a, expectCodexMissingAuthHint as i, runAcpRuntimeAdapterContract as n, expectedOpenaiPluginCodexCatalogEntriesWithGpt55 as o, expectAugmentedCodexCatalog as r, buildCommandTestParams as t };
