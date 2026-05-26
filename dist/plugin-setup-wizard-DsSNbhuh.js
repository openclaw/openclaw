import { p as setBundledChannelRuntime, r as getBundledChannelPlugin, u as listBundledChannelPluginIds } from "./bundled-0oTAwz0N.js";
import { x as setActivePluginRegistry } from "./runtime-DHxRl5F1.js";
import { r as createCapturedPluginRegistration } from "./bundled-capability-runtime-DUjDEDJd.js";
import { t as buildChannelSetupWizardAdapterFromSetupWizard } from "./setup-wizard-D1FjeAqn.js";
import { vi } from "vitest";
//#region src/test-utils/channel-plugins.ts
const createTestRegistry = (channels = []) => ({
	plugins: [],
	tools: [],
	hooks: [],
	typedHooks: [],
	channels,
	channelSetups: channels.map((entry) => ({
		pluginId: entry.pluginId,
		plugin: entry.plugin,
		source: entry.source,
		enabled: true
	})),
	providers: [],
	modelCatalogProviders: [],
	embeddingProviders: [],
	speechProviders: [],
	realtimeTranscriptionProviders: [],
	realtimeVoiceProviders: [],
	mediaUnderstandingProviders: [],
	imageGenerationProviders: [],
	videoGenerationProviders: [],
	musicGenerationProviders: [],
	webFetchProviders: [],
	webSearchProviders: [],
	migrationProviders: [],
	codexAppServerExtensionFactories: [],
	agentToolResultMiddlewares: [],
	memoryEmbeddingProviders: [],
	textTransforms: [],
	agentHarnesses: [],
	gatewayHandlers: {},
	gatewayMethodDescriptors: [],
	httpRoutes: [],
	cliRegistrars: [],
	reloads: [],
	nodeHostCommands: [],
	securityAuditCollectors: [],
	services: [],
	gatewayDiscoveryServices: [],
	commands: [],
	conversationBindingResolvedHandlers: [],
	diagnostics: []
});
const createChannelTestPluginBase = (params) => ({
	id: params.id,
	meta: {
		id: params.id,
		label: params.label ?? String(params.id),
		selectionLabel: params.label ?? String(params.id),
		docsPath: params.docsPath ?? `/channels/${params.id}`,
		blurb: "test stub.",
		...params.markdownCapable !== void 0 ? { markdownCapable: params.markdownCapable } : {}
	},
	capabilities: params.capabilities ?? { chatTypes: ["direct"] },
	config: {
		listAccountIds: () => ["default"],
		resolveAccount: () => ({}),
		...params.config
	}
});
const createOutboundTestPlugin = (params) => ({
	...createChannelTestPluginBase({
		id: params.id,
		label: params.label,
		docsPath: params.docsPath,
		capabilities: params.capabilities,
		config: { listAccountIds: () => [] }
	}),
	outbound: params.outbound,
	...params.messaging ? { messaging: params.messaging } : {}
});
//#endregion
//#region src/commands/channel-test-registry.ts
function resolveChannelPluginsForTests(onlyPluginIds) {
	return (onlyPluginIds ?? listBundledChannelPluginIds()).flatMap((id) => {
		const plugin = getBundledChannelPlugin(id);
		return plugin ? [plugin] : [];
	});
}
function createChannelTestRuntime() {
	return { state: { resolveStateDir: (_env, homeDir) => (homeDir ?? (() => "/tmp"))() } };
}
function setChannelPluginRegistryForTests(onlyPluginIds) {
	const plugins = resolveChannelPluginsForTests(onlyPluginIds);
	const runtime = createChannelTestRuntime();
	for (const plugin of plugins) try {
		setBundledChannelRuntime(plugin.id, runtime);
	} catch {}
	setActivePluginRegistry(createTestRegistry(plugins.map((plugin) => ({
		pluginId: plugin.id,
		plugin,
		source: "test"
	}))));
}
function setDefaultChannelPluginRegistryForTests() {
	setChannelPluginRegistryForTests();
}
//#endregion
//#region src/test-utils/plugin-registration.ts
async function registerSingleProviderPlugin(params) {
	const captured = createCapturedPluginRegistration();
	params.register(captured.api);
	const provider = captured.providers[0];
	if (!provider) throw new Error("provider registration missing");
	return provider;
}
async function registerProviderPlugin(params) {
	const captured = createCapturedPluginRegistration({
		id: params.id,
		name: params.name,
		source: "test"
	});
	params.plugin.register(captured.api);
	return {
		providers: captured.providers,
		realtimeTranscriptionProviders: captured.realtimeTranscriptionProviders,
		speechProviders: captured.speechProviders,
		mediaProviders: captured.mediaUnderstandingProviders,
		imageProviders: captured.imageGenerationProviders,
		musicProviders: captured.musicGenerationProviders,
		videoProviders: captured.videoGenerationProviders,
		modelCatalogProviders: captured.modelCatalogProviders
	};
}
async function registerProviderPlugins(...plugins) {
	const captured = createCapturedPluginRegistration();
	for (const plugin of plugins) plugin.register(captured.api);
	return captured.providers;
}
function requireRegisteredProvider(providers, providerId, label = "provider") {
	const provider = providers.find((entry) => entry.id === providerId);
	if (!provider) throw new Error(`${label} ${providerId} missing`);
	return provider;
}
//#endregion
//#region src/test-utils/plugin-runtime-env.ts
function createRuntimeEnv(options) {
	const throwOnExit = options?.throwOnExit ?? true;
	return {
		log: vi.fn(),
		error: vi.fn(),
		writeStdout: vi.fn(),
		writeJson: vi.fn(),
		exit: throwOnExit ? vi.fn((code) => {
			throw new Error(`exit ${code}`);
		}) : vi.fn()
	};
}
function createTypedRuntimeEnv(options, _runtimeShape) {
	return createRuntimeEnv(options);
}
function createNonExitingRuntimeEnv() {
	return createRuntimeEnv({ throwOnExit: false });
}
function createNonExitingTypedRuntimeEnv(runtimeShape) {
	return createTypedRuntimeEnv({ throwOnExit: false }, runtimeShape);
}
//#endregion
//#region src/test-utils/plugin-setup-wizard.ts
async function selectFirstWizardOption(params) {
	const first = params.options[0];
	if (!first) throw new Error("no options");
	return first.value;
}
function createTestWizardPrompter(overrides = {}) {
	return {
		intro: vi.fn(async () => {}),
		outro: vi.fn(async () => {}),
		note: vi.fn(async () => {}),
		plain: vi.fn(async () => {}),
		select: selectFirstWizardOption,
		multiselect: vi.fn(async () => []),
		text: vi.fn(async () => ""),
		confirm: vi.fn(async () => false),
		progress: vi.fn(() => ({
			update: vi.fn(),
			stop: vi.fn()
		})),
		...overrides
	};
}
function createQueuedWizardPrompter(params) {
	const selectValues = [...params?.selectValues ?? []];
	const textValues = [...params?.textValues ?? []];
	const confirmValues = [...params?.confirmValues ?? []];
	const intro = vi.fn(async () => void 0);
	const outro = vi.fn(async () => void 0);
	const note = vi.fn(async () => void 0);
	const plain = vi.fn(async () => void 0);
	const select = vi.fn(async () => selectValues.shift() ?? "");
	const multiselect = vi.fn(async () => []);
	const text = vi.fn(async () => textValues.shift() ?? "");
	const confirm = vi.fn(async () => confirmValues.shift() ?? false);
	const progress = vi.fn(() => ({
		update: vi.fn(),
		stop: vi.fn()
	}));
	return {
		intro,
		outro,
		note,
		plain,
		select,
		multiselect,
		text,
		confirm,
		progress,
		prompter: createTestWizardPrompter({
			intro,
			outro,
			note,
			plain,
			select,
			multiselect,
			text,
			confirm,
			progress
		})
	};
}
function isDeclarativeSetupWizard(setupWizard) {
	return Boolean(setupWizard && typeof setupWizard === "object" && "status" in setupWizard && "credentials" in setupWizard);
}
function requireDeclarativeSetupWizard(plugin) {
	const { setupWizard } = plugin;
	if (!setupWizard) throw new Error(`${plugin.id} is missing setupWizard`);
	if (!isDeclarativeSetupWizard(setupWizard)) throw new Error(`${plugin.id} setupWizard is adapter-shaped; test helper expects a wizard`);
	return setupWizard;
}
function resolveSetupWizardAccountContext(params) {
	return {
		cfg: params.cfg ?? {},
		accountId: params.accountId ?? "default",
		credentialValues: params.credentialValues ?? {}
	};
}
function resolveSetupWizardRuntime(runtime) {
	return runtime ?? createRuntimeEnv({ throwOnExit: false });
}
function resolveSetupWizardPrompter(prompter) {
	return prompter ?? createTestWizardPrompter();
}
function resolveSetupWizardNotePrompter(prompter) {
	return prompter ?? { note: vi.fn(async () => void 0) };
}
function createSetupWizardAdapter(params) {
	return buildChannelSetupWizardAdapterFromSetupWizard(params);
}
function createPluginSetupWizardAdapter(plugin) {
	return createSetupWizardAdapter({
		plugin,
		wizard: requireDeclarativeSetupWizard(plugin)
	});
}
function createPluginSetupWizardConfigure(plugin) {
	return createPluginSetupWizardAdapter(plugin).configure;
}
function createPluginSetupWizardStatus(plugin) {
	return createPluginSetupWizardAdapter(plugin).getStatus;
}
async function runSetupWizardConfigure(params) {
	return await params.configure({
		cfg: params.cfg ?? {},
		runtime: params.runtime ?? createRuntimeEnv(),
		prompter: params.prompter,
		options: params.options ?? {},
		accountOverrides: params.accountOverrides ?? {},
		shouldPromptAccountIds: params.shouldPromptAccountIds ?? false,
		forceAllowFrom: params.forceAllowFrom ?? false
	});
}
async function runSetupWizardPrepare(params) {
	const context = resolveSetupWizardAccountContext({
		cfg: params.cfg,
		accountId: params.accountId,
		credentialValues: params.credentialValues
	});
	return await params.prepare?.({
		...context,
		runtime: resolveSetupWizardRuntime(params.runtime),
		prompter: resolveSetupWizardPrompter(params.prompter),
		options: params.options
	});
}
async function runSetupWizardFinalize(params) {
	const context = resolveSetupWizardAccountContext({
		cfg: params.cfg,
		accountId: params.accountId,
		credentialValues: params.credentialValues
	});
	return await params.finalize?.({
		...context,
		runtime: resolveSetupWizardRuntime(params.runtime),
		prompter: resolveSetupWizardPrompter(params.prompter),
		options: params.options,
		forceAllowFrom: params.forceAllowFrom ?? false
	});
}
async function promptSetupWizardAllowFrom(params) {
	const context = resolveSetupWizardAccountContext({
		cfg: params.cfg,
		accountId: params.accountId
	});
	return await params.promptAllowFrom?.({
		cfg: context.cfg,
		accountId: context.accountId,
		prompter: resolveSetupWizardPrompter(params.prompter)
	});
}
async function resolveSetupWizardAllowFromEntries(params) {
	const context = resolveSetupWizardAccountContext({
		cfg: params.cfg,
		accountId: params.accountId,
		credentialValues: params.credentialValues
	});
	return await params.resolveEntries?.({
		...context,
		entries: params.entries
	});
}
async function resolveSetupWizardGroupAllowlist(params) {
	const context = resolveSetupWizardAccountContext({
		cfg: params.cfg,
		accountId: params.accountId,
		credentialValues: params.credentialValues
	});
	return await params.resolveAllowlist?.({
		...context,
		entries: params.entries,
		prompter: resolveSetupWizardNotePrompter(params.prompter)
	});
}
//#endregion
export { createOutboundTestPlugin as C, setDefaultChannelPluginRegistryForTests as S, createTypedRuntimeEnv as _, createSetupWizardAdapter as a, registerSingleProviderPlugin as b, resolveSetupWizardAllowFromEntries as c, runSetupWizardFinalize as d, runSetupWizardPrepare as f, createRuntimeEnv as g, createNonExitingTypedRuntimeEnv as h, createQueuedWizardPrompter as i, resolveSetupWizardGroupAllowlist as l, createNonExitingRuntimeEnv as m, createPluginSetupWizardConfigure as n, createTestWizardPrompter as o, selectFirstWizardOption as p, createPluginSetupWizardStatus as r, promptSetupWizardAllowFrom as s, createPluginSetupWizardAdapter as t, runSetupWizardConfigure as u, registerProviderPlugin as v, createTestRegistry as w, requireRegisteredProvider as x, registerProviderPlugins as y };
