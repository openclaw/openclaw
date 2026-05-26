import { t as loadPluginManifestRegistry } from "../manifest-registry-Cy1cBr1u.js";
import { a as parseSemver, n as isAtLeast } from "../runtime-guard-DLdnBLFm.js";
import { n as parseMinHostVersionRequirement } from "../min-host-version-Ceo2xu29.js";
import { t as pluginRegistrationContractRegistry } from "../registry-BlbU2sIq.js";
import { x as requireRegisteredProvider, y as registerProviderPlugins } from "../plugin-setup-wizard-DsSNbhuh.js";
import "../testing-C7rXcZLa.js";
import { n as assertUniqueValues, t as BUNDLED_RUNTIME_SIDECAR_PATHS } from "../runtime-sidecar-paths-Blgi5sh-.js";
import { a as registerTestPlugin, c as assertNoImportTimeSideEffects, i as createPluginRegistryFixture, n as loadBundledPluginPublicSurfaceSync, o as registerVirtualTestPlugin, r as resolveWorkspacePackagePublicModuleUrl, s as uniqueSortedStrings, t as loadBundledPluginPublicSurface } from "../public-surface-loader-B8tgO8c-.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
//#region src/plugin-sdk/test-helpers/direct-smoke.ts
const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHARED_IMPORT_ENV = {
	HOME: process.env.HOME,
	NODE_OPTIONS: process.env.NODE_OPTIONS,
	NODE_PATH: process.env.NODE_PATH,
	PATH: process.env.PATH,
	TERM: process.env.TERM
};
async function runDirectImportSmoke(code) {
	const { stdout } = await execFileAsync(process.execPath, [
		"--import",
		"tsx",
		"-e",
		code
	], {
		cwd: repoRoot,
		env: SHARED_IMPORT_ENV,
		timeout: 4e4
	});
	return stdout;
}
//#endregion
//#region src/plugin-sdk/test-helpers/package-manifest-contract.ts
function readJson(relativePath) {
	const absolutePath = path.resolve(process.cwd(), relativePath);
	return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}
function bundledPluginFile(pluginId, relativePath) {
	return `extensions/${pluginId}/${relativePath}`;
}
function describePackageManifestContract(params) {
	const packagePath = bundledPluginFile(params.pluginId, "package.json");
	describe(`${params.pluginId} package manifest contract`, () => {
		if (params.pluginLocalRuntimeDeps?.length) for (const dependencyName of params.pluginLocalRuntimeDeps) it(`keeps ${dependencyName} plugin-local`, () => {
			const rootManifest = readJson("package.json");
			const pluginManifest = readJson(packagePath);
			const pluginSpec = pluginManifest.dependencies?.[dependencyName] ?? pluginManifest.optionalDependencies?.[dependencyName];
			const rootSpec = rootManifest.dependencies?.[dependencyName] ?? rootManifest.optionalDependencies?.[dependencyName];
			expect(pluginSpec).toBeTruthy();
			expect(rootSpec).toBeUndefined();
		});
		const minHostVersionBaseline = params.minHostVersionBaseline;
		if (minHostVersionBaseline) it("declares a parseable minHostVersion floor at or above the baseline", () => {
			const baseline = parseSemver(minHostVersionBaseline);
			expect(baseline).not.toBeNull();
			if (!baseline) return;
			const requirement = parseMinHostVersionRequirement(readJson(packagePath).openclaw?.install?.minHostVersion ?? null);
			expect(requirement, `${packagePath} should declare openclaw.install.minHostVersion`).not.toBeNull();
			if (!requirement) return;
			const minimum = parseSemver(requirement.minimumLabel);
			expect(minimum, `${packagePath} should use a parseable semver floor`).not.toBeNull();
			if (!minimum) return;
			expect(isAtLeast(minimum, baseline), `${packagePath} should require at least OpenClaw ${minHostVersionBaseline}`).toBe(true);
		});
	});
}
//#endregion
//#region src/plugin-sdk/test-helpers/plugin-registration-contract-cases.ts
const pluginRegistrationContractCases = {
	anthropic: {
		pluginId: "anthropic",
		providerIds: ["anthropic"],
		mediaUnderstandingProviderIds: ["anthropic"],
		cliBackendIds: ["claude-cli"],
		requireDescribeImages: true
	},
	brave: {
		pluginId: "brave",
		webSearchProviderIds: ["brave"]
	},
	comfy: {
		pluginId: "comfy",
		providerIds: ["comfy"],
		imageGenerationProviderIds: ["comfy"],
		musicGenerationProviderIds: ["comfy"],
		videoGenerationProviderIds: ["comfy"],
		requireGenerateImage: true,
		requireGenerateVideo: true
	},
	deepgram: {
		pluginId: "deepgram",
		mediaUnderstandingProviderIds: ["deepgram"]
	},
	duckduckgo: {
		pluginId: "duckduckgo",
		webSearchProviderIds: ["duckduckgo"]
	},
	elevenlabs: {
		pluginId: "elevenlabs",
		speechProviderIds: ["elevenlabs"],
		requireSpeechVoices: true
	},
	exa: {
		pluginId: "exa",
		webSearchProviderIds: ["exa"]
	},
	fal: {
		pluginId: "fal",
		providerIds: ["fal"],
		imageGenerationProviderIds: ["fal"],
		musicGenerationProviderIds: ["fal"]
	},
	firecrawl: {
		pluginId: "firecrawl",
		webFetchProviderIds: ["firecrawl"],
		webSearchProviderIds: ["firecrawl"],
		toolNames: ["firecrawl_search", "firecrawl_scrape"]
	},
	google: {
		pluginId: "google",
		providerIds: [
			"google",
			"google-gemini-cli",
			"google-vertex"
		],
		webSearchProviderIds: ["gemini"],
		realtimeVoiceProviderIds: ["google"],
		speechProviderIds: ["google"],
		mediaUnderstandingProviderIds: ["google"],
		imageGenerationProviderIds: ["google"],
		requireDescribeImages: true,
		requireGenerateImage: true
	},
	groq: {
		pluginId: "groq",
		mediaUnderstandingProviderIds: ["groq"]
	},
	microsoft: {
		pluginId: "microsoft",
		speechProviderIds: ["microsoft"],
		requireSpeechVoices: true
	},
	minimax: {
		pluginId: "minimax",
		providerIds: ["minimax", "minimax-portal"],
		mediaUnderstandingProviderIds: ["minimax", "minimax-portal"],
		imageGenerationProviderIds: ["minimax", "minimax-portal"],
		requireDescribeImages: true,
		requireGenerateImage: true
	},
	mistral: {
		pluginId: "mistral",
		mediaUnderstandingProviderIds: ["mistral"]
	},
	moonshot: {
		pluginId: "moonshot",
		providerIds: ["moonshot"],
		webSearchProviderIds: ["kimi"],
		mediaUnderstandingProviderIds: ["moonshot"],
		requireDescribeImages: true,
		manifestAuthChoice: {
			pluginId: "kimi",
			choiceId: "kimi-code-api-key",
			choiceLabel: "Kimi Code API key (subscription)",
			groupId: "moonshot",
			groupLabel: "Moonshot AI (Kimi K2.6)",
			groupHint: "Kimi K2.6"
		}
	},
	openai: {
		pluginId: "openai",
		providerIds: ["openai", "openai-codex"],
		speechProviderIds: ["openai"],
		realtimeTranscriptionProviderIds: ["openai"],
		realtimeVoiceProviderIds: ["openai"],
		mediaUnderstandingProviderIds: ["openai", "openai-codex"],
		imageGenerationProviderIds: ["openai"],
		requireSpeechVoices: true,
		requireDescribeImages: true,
		requireGenerateImage: true
	},
	openrouter: {
		pluginId: "openrouter",
		providerIds: ["openrouter"],
		mediaUnderstandingProviderIds: ["openrouter"],
		imageGenerationProviderIds: ["openrouter"],
		musicGenerationProviderIds: ["openrouter"],
		videoGenerationProviderIds: ["openrouter"],
		requireDescribeImages: true,
		requireGenerateImage: true,
		requireGenerateVideo: true
	},
	perplexity: {
		pluginId: "perplexity",
		webSearchProviderIds: ["perplexity"]
	},
	senseaudio: {
		pluginId: "senseaudio",
		mediaUnderstandingProviderIds: ["senseaudio"]
	},
	tavily: {
		pluginId: "tavily",
		webSearchProviderIds: ["tavily"],
		toolNames: ["tavily_search", "tavily_extract"]
	},
	"tts-local-cli": {
		pluginId: "tts-local-cli",
		speechProviderIds: ["tts-local-cli", "cli"]
	},
	xai: {
		pluginId: "xai",
		providerIds: ["xai"],
		webSearchProviderIds: ["grok"],
		realtimeTranscriptionProviderIds: ["xai"],
		mediaUnderstandingProviderIds: ["xai"]
	},
	zai: {
		pluginId: "zai",
		mediaUnderstandingProviderIds: ["zai"],
		requireDescribeImages: true
	}
};
//#endregion
//#region src/plugin-sdk/test-helpers/plugin-registration-contract.ts
function findRegistration(pluginId) {
	const entry = pluginRegistrationContractRegistry.find((candidate) => candidate.pluginId === pluginId);
	if (!entry) throw new Error(`plugin registration contract missing for ${pluginId}`);
	return entry;
}
function describePluginRegistrationContract(params) {
	describe(`${params.pluginId} plugin registration contract`, () => {
		if (params.cliBackendIds) it("keeps bundled cli-backend ownership explicit", () => {
			expect(findRegistration(params.pluginId).cliBackendIds).toEqual(params.cliBackendIds);
		});
		if (params.providerIds) it("keeps bundled provider ownership explicit", () => {
			expect(findRegistration(params.pluginId).providerIds).toEqual(params.providerIds);
		});
		if (params.webSearchProviderIds) it("keeps bundled web search ownership explicit", () => {
			expect(findRegistration(params.pluginId).webSearchProviderIds).toEqual(params.webSearchProviderIds);
		});
		if (params.webFetchProviderIds) it("keeps bundled web fetch ownership explicit", () => {
			expect(findRegistration(params.pluginId).webFetchProviderIds).toEqual(params.webFetchProviderIds);
		});
		if (params.speechProviderIds) it("keeps bundled speech ownership explicit", () => {
			expect(findRegistration(params.pluginId).speechProviderIds).toEqual(params.speechProviderIds);
		});
		if (params.realtimeTranscriptionProviderIds) it("keeps bundled realtime-transcription ownership explicit", () => {
			expect(findRegistration(params.pluginId).realtimeTranscriptionProviderIds).toEqual(params.realtimeTranscriptionProviderIds);
		});
		if (params.realtimeVoiceProviderIds) it("keeps bundled realtime-voice ownership explicit", () => {
			expect(findRegistration(params.pluginId).realtimeVoiceProviderIds).toEqual(params.realtimeVoiceProviderIds);
		});
		if (params.mediaUnderstandingProviderIds) it("keeps bundled media-understanding ownership explicit", () => {
			expect(findRegistration(params.pluginId).mediaUnderstandingProviderIds).toEqual(params.mediaUnderstandingProviderIds);
		});
		if (params.imageGenerationProviderIds) it("keeps bundled image-generation ownership explicit", () => {
			expect(findRegistration(params.pluginId).imageGenerationProviderIds).toEqual(params.imageGenerationProviderIds);
		});
		if (params.videoGenerationProviderIds) it("keeps bundled video-generation ownership explicit", () => {
			expect(findRegistration(params.pluginId).videoGenerationProviderIds).toEqual(params.videoGenerationProviderIds);
		});
		if (params.musicGenerationProviderIds) it("keeps bundled music-generation ownership explicit", () => {
			expect(findRegistration(params.pluginId).musicGenerationProviderIds).toEqual(params.musicGenerationProviderIds);
		});
		if (params.toolNames) it("keeps bundled tool ownership explicit", () => {
			expect(findRegistration(params.pluginId).toolNames).toEqual(params.toolNames);
		});
		const manifestAuthChoice = params.manifestAuthChoice;
		if (manifestAuthChoice) it("keeps onboarding auth grouping explicit", () => {
			expect(loadPluginManifestRegistry({}).plugins.find((entry) => entry.origin === "bundled" && entry.id === manifestAuthChoice.pluginId)?.providerAuthChoices).toEqual(expect.arrayContaining([expect.objectContaining({
				choiceId: manifestAuthChoice.choiceId,
				choiceLabel: manifestAuthChoice.choiceLabel,
				groupId: manifestAuthChoice.groupId,
				groupLabel: manifestAuthChoice.groupLabel,
				groupHint: manifestAuthChoice.groupHint
			})]));
		});
	});
}
//#endregion
//#region src/plugin-sdk/test-helpers/public-artifacts.ts
function getPublicArtifactBasename(relativePath) {
	return relativePath.split("/").at(-1) ?? relativePath;
}
const EXTRA_GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES = assertUniqueValues([
	"action-runtime.runtime.js",
	"action-runtime-api.js",
	"allow-from.js",
	"api.js",
	"auth-presence.js",
	"channel-config-api.js",
	"index.js",
	"login-qr-api.js",
	"onboard.js",
	"openai-codex-catalog.js",
	"provider-catalog.js",
	"session-key-api.js",
	"setup-api.js",
	"setup-entry.js",
	"timeouts.js",
	"x-search.js"
], "extra guarded extension public surface basename");
const BUNDLED_RUNTIME_SIDECAR_BASENAMES = assertUniqueValues([...new Set(BUNDLED_RUNTIME_SIDECAR_PATHS.map(getPublicArtifactBasename))], "bundled runtime sidecar basename");
const GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES = assertUniqueValues([...BUNDLED_RUNTIME_SIDECAR_BASENAMES, ...EXTRA_GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES], "guarded extension public surface basename");
//#endregion
export { BUNDLED_RUNTIME_SIDECAR_BASENAMES, GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES, assertNoImportTimeSideEffects, createPluginRegistryFixture, describePackageManifestContract, describePluginRegistrationContract, getPublicArtifactBasename, loadBundledPluginPublicSurface, loadBundledPluginPublicSurfaceSync, pluginRegistrationContractCases, registerProviderPlugins as registerProviders, registerTestPlugin, registerVirtualTestPlugin, requireRegisteredProvider as requireProvider, resolveWorkspacePackagePublicModuleUrl, runDirectImportSmoke, uniqueSortedStrings };
