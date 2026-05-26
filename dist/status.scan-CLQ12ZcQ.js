import { l as hasConfiguredChannelsForReadOnlyScope } from "./channel-plugin-ids-nB-ga3MN.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
import { r as buildPluginCompatibilitySnapshotNotices } from "./status-BvY0BMpM.js";
import { t as collectStatusScanOverview } from "./status.scan-overview-XRCiRhU1.js";
import { i as executeStatusScanFromOverview, n as scanStatusJsonWithPolicy, r as resolveStatusMemoryStatusSnapshot } from "./status.scan.fast-json-EhiOmSLp.js";
//#region src/commands/status.scan.ts
async function scanStatus(opts, _runtime) {
	if (opts.json) return await scanStatusJsonWithPolicy({
		timeoutMs: opts.timeoutMs,
		all: opts.all
	}, _runtime, {
		commandName: "status --json",
		resolveHasConfiguredChannels: (cfg, sourceConfig) => hasConfiguredChannelsForReadOnlyScope({
			config: cfg,
			activationSourceConfig: sourceConfig
		}),
		resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) => await resolveStatusMemoryStatusSnapshot({
			cfg,
			agentStatus,
			memoryPlugin
		})
	});
	return await withProgress({
		label: "Scanning status…",
		total: 10,
		enabled: true
	}, async (progress) => {
		const includeLiveChannelChecks = opts.all === true || opts.deep === true;
		const overview = await collectStatusScanOverview({
			commandName: "status",
			opts,
			showSecrets: process.env.OPENCLAW_SHOW_SECRETS?.trim() !== "0",
			includeLiveChannelStatus: includeLiveChannelChecks,
			includeChannelSetupRuntimeFallback: true,
			progress,
			labels: {
				loadingConfig: "Loading config…",
				checkingTailscale: "Checking Tailscale…",
				checkingForUpdates: "Checking for updates…",
				resolvingAgents: "Resolving agents…",
				probingGateway: "Probing gateway…",
				queryingChannelStatus: "Querying channel status…",
				summarizingChannels: "Summarizing channels…"
			}
		});
		progress.setLabel("Checking plugins…");
		const pluginCompatibility = opts.all ? buildPluginCompatibilitySnapshotNotices({ config: overview.cfg }) : [];
		progress.tick();
		progress.setLabel("Checking memory and sessions…");
		const result = await executeStatusScanFromOverview({
			overview,
			resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) => opts.all ? await resolveStatusMemoryStatusSnapshot({
				cfg,
				agentStatus,
				memoryPlugin
			}) : null,
			channelIssues: overview.channelIssues,
			channels: overview.channels,
			pluginCompatibility
		});
		progress.tick();
		progress.setLabel("Rendering…");
		progress.tick();
		return result;
	});
}
//#endregion
export { scanStatus };
