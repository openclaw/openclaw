import { c as normalizeOptionalString, d as normalizeStringifiedOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./ssrf-runtime-Be2o3zD7.js";
import { b as usesFoundryResponsesByDefault, l as buildFoundryProviderBaseUrl, m as requiresFoundryMaxCompletionTokens, n as DEFAULT_API, r as DEFAULT_GPT5_API, u as extractFoundryEndpoint } from "./shared-BspuLN8V.js";
import { i as getAccessTokenResult, n as azLoginDeviceCodeWithOptions, o as getLoggedInAccount, r as execAz, t as azLoginDeviceCode } from "./cli-BFjcU0vW.js";
//#region extensions/microsoft-foundry/onboard.ts
function listFoundryResources(subscriptionId) {
	try {
		const accounts = JSON.parse(execAz([
			"cognitiveservices",
			"account",
			"list",
			...subscriptionId ? ["--subscription", subscriptionId] : [],
			"--query",
			"[].{id:id,name:name,kind:kind,location:location,resourceGroup:resourceGroup,endpoint:properties.endpoint,customSubdomain:properties.customSubDomainName,projects:properties.associatedProjects}",
			"--output",
			"json"
		]));
		const resources = [];
		for (const account of accounts) {
			if (!account.resourceGroup) continue;
			if (account.kind === "OpenAI") {
				const endpoint = extractFoundryEndpoint(account.endpoint);
				if (!endpoint) continue;
				resources.push({
					id: account.id,
					accountName: account.name,
					kind: "OpenAI",
					location: account.location,
					resourceGroup: account.resourceGroup,
					endpoint,
					projects: []
				});
				continue;
			}
			if (account.kind !== "AIServices") continue;
			const customSubdomain = normalizeOptionalString(account.customSubdomain);
			const endpoint = customSubdomain ? `https://${customSubdomain}.services.ai.azure.com` : void 0;
			if (!endpoint) continue;
			resources.push({
				id: account.id,
				accountName: account.name,
				kind: "AIServices",
				location: account.location,
				resourceGroup: account.resourceGroup,
				endpoint,
				projects: Array.isArray(account.projects) ? account.projects.filter((project) => typeof project === "string") : []
			});
		}
		return resources;
	} catch {
		return [];
	}
}
function listResourceDeployments(resource, subscriptionId) {
	try {
		return JSON.parse(execAz([
			"cognitiveservices",
			"account",
			"deployment",
			"list",
			...subscriptionId ? ["--subscription", subscriptionId] : [],
			"-g",
			resource.resourceGroup,
			"-n",
			resource.accountName,
			"--query",
			"[].{name:name,modelName:properties.model.name,modelVersion:properties.model.version,state:properties.provisioningState,sku:sku.name}",
			"--output",
			"json"
		])).filter((deployment) => deployment.state === "Succeeded");
	} catch {
		return [];
	}
}
function buildCreateFoundryHint(selectedSub) {
	return [
		`No Azure AI Foundry or Azure OpenAI resources were found in subscription ${selectedSub.name} (${selectedSub.id}).`,
		"Create one in Azure AI Foundry or Azure Portal, then rerun onboard.",
		"Azure AI Foundry: https://ai.azure.com",
		"Azure OpenAI docs: https://learn.microsoft.com/azure/ai-foundry/openai/how-to/create-resource"
	].join("\n");
}
async function selectFoundryResource(ctx, selectedSub) {
	const resources = listFoundryResources(selectedSub.id);
	if (resources.length === 0) throw new Error(buildCreateFoundryHint(selectedSub));
	if (resources.length === 1) {
		const only = resources[0];
		await ctx.prompter.note(`Using ${only.kind === "AIServices" ? "Azure AI Foundry" : "Azure OpenAI"} resource: ${only.accountName}`, "Foundry Resource");
		return only;
	}
	const selectedResourceId = await ctx.prompter.select({
		message: "Select Azure AI Foundry / Azure OpenAI resource",
		options: resources.map((resource) => ({
			value: resource.id,
			label: `${resource.accountName} (${resource.kind === "AIServices" ? "Azure AI Foundry" : "Azure OpenAI"}${resource.location ? `, ${resource.location}` : ""})`,
			hint: [`RG: ${resource.resourceGroup}`, resource.projects.length > 0 ? `${resource.projects.length} project(s)` : void 0].filter(Boolean).join(" | ")
		}))
	});
	return resources.find((resource) => resource.id === selectedResourceId) ?? resources[0];
}
async function selectFoundryDeployment(ctx, resource, deployments) {
	if (deployments.length === 0) throw new Error([`No model deployments were found in ${resource.accountName}.`, "Deploy a model in Azure AI Foundry or Azure OpenAI, then rerun onboard."].join("\n"));
	if (deployments.length === 1) {
		const only = deployments[0];
		await ctx.prompter.note(`Using deployment: ${only.name}`, "Model Deployment");
		return only;
	}
	const selectedDeploymentName = await ctx.prompter.select({
		message: "Select model deployment",
		options: deployments.map((deployment) => ({
			value: deployment.name,
			label: deployment.name,
			hint: [
				deployment.modelName,
				deployment.modelVersion,
				deployment.sku
			].filter(Boolean).join(" | ")
		}))
	});
	return deployments.find((deployment) => deployment.name === selectedDeploymentName) ?? deployments[0];
}
async function promptFoundryApi(ctx, initialApi) {
	return await ctx.prompter.select({
		message: "Select request API",
		options: [{
			value: DEFAULT_GPT5_API,
			label: "Responses API",
			hint: "Recommended for Azure OpenAI GPT, o-series, and Codex deployments"
		}, {
			value: "openai-completions",
			label: "Chat Completions API",
			hint: "Use for Foundry models that only expose chat/completions semantics"
		}],
		initialValue: initialApi
	});
}
async function promptFoundryModelFamily(ctx) {
	return await ctx.prompter.select({
		message: "Model family",
		options: [{
			value: "reasoning-family",
			label: "GPT-5 series / o-series / Codex",
			hint: "Use for Azure OpenAI reasoning and Codex deployments"
		}, {
			value: "other-chat",
			label: "Other chat model",
			hint: "Use for other chat/completions style Foundry models"
		}],
		initialValue: "reasoning-family"
	});
}
async function promptEndpointAndModelBase(ctx, options) {
	const endpoint = (await ctx.prompter.text({
		message: "Microsoft Foundry endpoint URL",
		placeholder: "https://xxx.openai.azure.com or https://xxx.services.ai.azure.com",
		...options?.endpointInitialValue ? { initialValue: options.endpointInitialValue } : {},
		validate: (v) => {
			const val = normalizeStringifiedOptionalString(v) ?? "";
			if (!val) return "Endpoint URL is required";
			return URL.canParse(val) ? void 0 : "Invalid URL";
		}
	})).trim();
	const modelId = (await ctx.prompter.text({
		message: "Default model/deployment name",
		...options?.modelInitialValue ? { initialValue: options.modelInitialValue } : {},
		placeholder: "gpt-4o",
		validate: (v) => {
			if (!(normalizeStringifiedOptionalString(v) ?? "")) return "Model ID is required";
		}
	})).trim();
	const familyChoice = await promptFoundryModelFamily(ctx);
	const resolvedModelName = familyChoice === "reasoning-family" ? usesFoundryResponsesByDefault(modelId) || requiresFoundryMaxCompletionTokens(modelId) ? modelId : "gpt-5" : void 0;
	const api = await promptFoundryApi(ctx, familyChoice === "reasoning-family" ? DEFAULT_GPT5_API : DEFAULT_API);
	return {
		endpoint,
		modelId,
		...resolvedModelName ? { modelNameHint: resolvedModelName } : {},
		api
	};
}
async function promptEndpointAndModelManually(ctx) {
	return promptEndpointAndModelBase(ctx);
}
async function promptApiKeyEndpointAndModel(ctx) {
	return promptEndpointAndModelBase(ctx, {
		endpointInitialValue: process.env.AZURE_OPENAI_ENDPOINT,
		modelInitialValue: "gpt-4o"
	});
}
function buildFoundryConnectionTest(params) {
	const baseUrl = buildFoundryProviderBaseUrl(params.endpoint, params.modelId, params.modelNameHint, params.api);
	if (params.api === "openai-responses") return {
		url: `${baseUrl}/responses`,
		body: {
			model: params.modelId,
			input: "hi",
			max_output_tokens: 16
		}
	};
	return {
		url: `${baseUrl}/chat/completions`,
		body: {
			model: params.modelId,
			messages: [{
				role: "user",
				content: "hi"
			}],
			max_tokens: 1
		}
	};
}
function extractTenantSuggestions(rawMessage) {
	const suggestions = [];
	const seen = /* @__PURE__ */ new Set();
	for (const match of rawMessage.matchAll(/([0-9a-fA-F-]{36})(?:\s+'([^'\r\n]+)')?/g)) {
		const id = normalizeOptionalString(match[1]);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		suggestions.push({
			id,
			...normalizeOptionalString(match[2]) ? { label: normalizeOptionalString(match[2]) } : {}
		});
	}
	return suggestions;
}
function isValidTenantIdentifier(value) {
	const trimmed = normalizeOptionalString(value) ?? "";
	if (!trimmed) return false;
	const isTenantUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(trimmed);
	const isTenantDomain = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(trimmed);
	return isTenantUuid || isTenantDomain;
}
async function promptTenantId(ctx, params) {
	const suggestionLines = params?.suggestions && params.suggestions.length > 0 ? params.suggestions.map((entry) => `- ${entry.id}${entry.label ? ` (${entry.label})` : ""}`) : [];
	if (params?.reason || suggestionLines.length > 0) await ctx.prompter.note([
		params?.reason,
		suggestionLines.length > 0 ? "Suggested tenants:" : void 0,
		...suggestionLines
	].filter(Boolean).join("\n"), "Azure Tenant");
	return (await ctx.prompter.text({
		message: params?.required ? "Azure tenant ID" : "Azure tenant ID (optional)",
		placeholder: params?.suggestions?.[0]?.id ?? "00000000-0000-0000-0000-000000000000",
		validate: (value) => {
			const trimmed = normalizeStringifiedOptionalString(value) ?? "";
			if (!trimmed) return params?.required ? "Tenant ID is required" : void 0;
			return isValidTenantIdentifier(trimmed) ? void 0 : "Enter a valid tenant ID or tenant domain";
		}
	})).trim() || void 0;
}
async function loginWithTenantFallback(ctx) {
	try {
		await azLoginDeviceCode();
		return { account: getLoggedInAccount() };
	} catch (error) {
		const message = formatErrorMessage(error);
		if (!(/AADSTS\d+/i.test(message) || /no subscriptions found/i.test(message) || /Please provide a valid tenant/i.test(message) || /tenant.*not found/i.test(message))) throw error;
		const tenantId = await promptTenantId(ctx, {
			suggestions: extractTenantSuggestions(message),
			required: true,
			reason: "Azure login needs a tenant-scoped retry. This often happens when your tenant requires MFA or your account has no Azure subscriptions."
		});
		await azLoginDeviceCodeWithOptions({
			tenantId,
			allowNoSubscriptions: true
		});
		return {
			account: getLoggedInAccount(),
			tenantId
		};
	}
}
async function testFoundryConnection(params) {
	try {
		const { accessToken } = getAccessTokenResult({
			subscriptionId: params.subscriptionId,
			tenantId: params.tenantId
		});
		const testRequest = buildFoundryConnectionTest({
			endpoint: params.endpoint,
			modelId: params.modelId,
			modelNameHint: params.modelNameHint,
			api: params.api
		});
		const { response: res, release } = await fetchWithSsrFGuard({
			url: testRequest.url,
			init: {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json"
				},
				body: JSON.stringify(testRequest.body)
			},
			timeoutMs: 15e3
		});
		try {
			if (res.status === 400) {
				const body = await res.text().catch(() => "");
				await params.ctx.prompter.note(`Endpoint is reachable but returned 400 Bad Request - check your deployment name and API version.\n${body.slice(0, 200)}`, "Connection Test");
			} else if (!res.ok) {
				const body = await res.text().catch(() => "");
				await params.ctx.prompter.note(`Warning: test request returned ${res.status}. ${body.slice(0, 200)}\nProceeding anyway - you can fix the endpoint later.`, "Connection Test");
			} else await params.ctx.prompter.note("Connection test successful!", "✓");
		} finally {
			await release();
		}
	} catch (err) {
		await params.ctx.prompter.note(`Warning: connection test failed: ${String(err)}\nProceeding anyway.`, "Connection Test");
	}
}
//#endregion
export { promptApiKeyEndpointAndModel as a, selectFoundryDeployment as c, loginWithTenantFallback as i, selectFoundryResource as l, isValidTenantIdentifier as n, promptEndpointAndModelManually as o, listResourceDeployments as r, promptTenantId as s, buildFoundryConnectionTest as t, testFoundryConnection as u };
