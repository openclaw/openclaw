import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import "./env-GwU3cB_J.js";
import "./manifest-registry-BJhx3ruM.js";
import "./runtime-guard-BuMdLq1N.js";
import "./min-host-version-W1db37pp.js";
import "./io-ByDvK3jv.js";
import "./safe-text-BqXgiOsp.js";
import "./call-CTkOURQV.js";
import "./loader-6lcDM5MI.js";
import "./hook-runner-global-D9YraNzb.js";
import "./runtime-Dq8mY7X0.js";
import "./facade-runtime-CJ1KLfx_.js";
import { a as toAcpRuntimeError } from "./errors-UGV84Ac_.js";
import "./provider-discovery-CgliCyMf.js";
import "./failover-matches-fd-kR6sE.js";
import "./system-events-BqE7TU70.js";
import "./task-registry-D4ZB_K3o.js";
import "./bundled-capability-runtime-DggPBewq.js";
import "./deliver-DlImowHI.js";
import "./live-auth-keys-DGNFd1ZR.js";
import "./web-provider-public-artifacts.explicit-gfSsXelD.js";
import "./registry-QnbH48Hk.js";
import "./manager-DClbl-0C.js";
import "./runtime-taskflow-D54az6I0.js";
import { t as buildCommandContext } from "./commands-context-Dl5xZC3i.js";
import { t as parseInlineDirectives } from "./directive-handling.parse-DYUNWj1d.js";
import "./png-encode-Bl9eufcV.js";
import "./hooks.test-helpers-BIGEDron.js";
import "./resolve-target-error-cases-DG7kQo1C.js";
import "./inbound-testkit-DYehgVEW.js";
import "./typed-cases-DjRNH39j.js";
import "./plugin-setup-wizard-DFMbPPLu.js";
import "./runtime-sidecar-paths-BEaVCFF6.js";
import "./provider-wizard-BGHWLCUP.js";
import "./provider-auth-choice.runtime-LmR4_Bir.js";
import "./frozen-time-B9nqxKnG.js";
import "./commands-acp-uOeaGLTB.js";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
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
	expect(buildProviderMissingAuthMessageWithPlugin({
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
	expect(result).toHaveLength(expectedEntries.length);
	for (const entry of expectedEntries) expect(result).toContainEqual(expect.objectContaining(entry));
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
	expect(handle.sessionKey).toBe(sessionKey);
	expect(handle.backend.trim()).not.toHaveLength(0);
	expect(handle.runtimeSessionName.trim()).not.toHaveLength(0);
	const successEvents = [];
	for await (const event of runtime.runTurn({
		handle,
		text: params.successPrompt ?? "contract-success",
		mode: "prompt",
		requestId: `contract-success-${randomUUID()}`
	})) successEvents.push(event);
	expect(successEvents.some((event) => event.type === "done" || event.type === "text_delta" || event.type === "status" || event.type === "tool_call")).toBe(true);
	expect(successEvents.some((event) => event.type === "done")).toBe(true);
	await params.assertSuccessEvents?.(successEvents);
	if (params.includeControlChecks ?? true) {
		if (runtime.getStatus) {
			const status = await runtime.getStatus({ handle });
			expect(status).toBeDefined();
			expect(typeof status).toBe("object");
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
		expect(Boolean(errorThrown) || sawErrorEvent).toBe(true);
		if (errorThrown) {
			const acpError = toAcpRuntimeError({
				error: errorThrown,
				fallbackCode: "ACP_TURN_FAILED",
				fallbackMessage: "ACP runtime contract expected an error turn failure."
			});
			expect(acpError.code.length).toBeGreaterThan(0);
			expect(acpError.message.length).toBeGreaterThan(0);
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
