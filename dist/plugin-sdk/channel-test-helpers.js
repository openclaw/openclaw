import { r as stripAnsi } from "../ansi-4r6vVvJt.js";
import { b as escapeRegExp } from "../utils-sBTEdeml.js";
import { a as resetGlobalHookRunner, i as initializeGlobalHookRunner } from "../hook-runner-global-BkXXy1ub.js";
import { F as createEmptyPluginRegistry, m as releasePinnedPluginChannelRegistry, x as setActivePluginRegistry } from "../runtime-DHxRl5F1.js";
import { n as resolveInboundMentionDecision, t as implicitMentionKindWhen } from "../mention-gating-3P8aSD7o.js";
import { t as deliverOutboundPayloads } from "../deliver-WPtVqUMT.js";
import { n as formatZonedTimestamp, t as formatUtcTimestamp } from "../format-datetime-DO2rqkXr.js";
import { i as shouldAckReaction, n as removeAckReactionAfterReply, r as removeAckReactionHandleAfterReply, t as createAckReactionHandle } from "../ack-reactions-BceP3SaE.js";
import { t as addTestHook } from "../hooks.test-helpers-C0hHeapp.js";
import { C as createOutboundTestPlugin, g as createRuntimeEnv, w as createTestRegistry } from "../plugin-setup-wizard-DsSNbhuh.js";
import "../testing-C7rXcZLa.js";
import "../channel-mention-gating-C0znWBFq.js";
import { expect, it, vi } from "vitest";
//#region src/plugin-sdk/test-helpers/directory.ts
function createDirectoryTestRuntime() {
	return {
		log: () => {},
		error: () => {},
		exit: (code) => {
			throw new Error(`exit ${code}`);
		}
	};
}
function expectDirectorySurface(directory) {
	if (!directory || typeof directory !== "object") throw new Error("expected directory");
	const { listPeers, listGroups } = directory;
	if (!listPeers) throw new Error("expected listPeers");
	if (!listGroups) throw new Error("expected listGroups");
	return {
		listPeers,
		listGroups
	};
}
//#endregion
//#region src/plugin-sdk/test-helpers/directory-ids.ts
async function expectDirectoryIds(listFn, cfg, expected, options) {
	const ids = (await listFn({
		cfg,
		accountId: "default",
		query: null,
		limit: null
	})).map((entry) => entry.id);
	expect(options?.sorted ? sortDirectoryIds(ids) : ids).toEqual(options?.sorted ? sortDirectoryIds(expected) : expected);
}
function compareDirectoryIds(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}
function sortDirectoryIds(values) {
	return values.toSorted(compareDirectoryIds);
}
//#endregion
//#region src/plugin-sdk/test-helpers/channel-contract-suites.ts
function sortStrings(values) {
	return [...values].toSorted((left, right) => left.localeCompare(right));
}
function resolveContractMessageDiscovery(params) {
	const actions = params.plugin.actions;
	if (!actions) return {
		actions: [],
		capabilities: []
	};
	const discovery = actions.describeMessageTool({ cfg: params.cfg }) ?? null;
	return {
		actions: Array.isArray(discovery?.actions) ? [...discovery.actions] : [],
		capabilities: Array.isArray(discovery?.capabilities) ? discovery.capabilities : []
	};
}
function installChannelPluginContractSuite(params) {
	it("satisfies the base channel plugin contract", () => {
		expectChannelPluginContract(params.plugin);
	});
}
function expectChannelPluginContract(plugin) {
	expect(typeof plugin.id).toBe("string");
	expect(plugin.id.trim()).not.toBe("");
	expect(plugin.meta.id).toBe(plugin.id);
	expect(plugin.meta.label.trim()).not.toBe("");
	expect(plugin.meta.selectionLabel.trim()).not.toBe("");
	expect(plugin.meta.docsPath).toMatch(/^\/channels\//);
	expect(plugin.meta.blurb.trim()).not.toBe("");
	expect(plugin.capabilities.chatTypes.length).toBeGreaterThan(0);
	expect(typeof plugin.config.listAccountIds).toBe("function");
	expect(typeof plugin.config.resolveAccount).toBe("function");
}
function installChannelActionsContractSuite(params) {
	it("exposes the base message actions contract", () => {
		expect(params.plugin.actions).toBeDefined();
		expect(typeof params.plugin.actions?.describeMessageTool).toBe("function");
	});
	for (const testCase of params.cases) it(`actions contract: ${testCase.name}`, () => {
		testCase.beforeTest?.();
		const discovery = resolveContractMessageDiscovery({
			plugin: params.plugin,
			cfg: testCase.cfg
		});
		const actions = discovery.actions;
		const capabilities = discovery.capabilities;
		expect(actions).toEqual([...new Set(actions)]);
		expect(capabilities).toEqual([...new Set(capabilities)]);
		expect(sortStrings(actions)).toEqual(sortStrings(testCase.expectedActions));
		expect(sortStrings(capabilities)).toEqual(sortStrings(testCase.expectedCapabilities ?? []));
		if (params.plugin.actions?.supportsAction) {
			for (const action of testCase.expectedActions) expect(params.plugin.actions.supportsAction({ action })).toBe(true);
			if (params.unsupportedAction && !testCase.expectedActions.includes(params.unsupportedAction)) expect(params.plugin.actions.supportsAction({ action: params.unsupportedAction })).toBe(false);
		}
	});
}
function installChannelSetupContractSuite(params) {
	it("exposes the base setup contract", () => {
		expect(params.plugin.setup).toBeDefined();
		expect(typeof params.plugin.setup?.applyAccountConfig).toBe("function");
	});
	for (const testCase of params.cases) it(`setup contract: ${testCase.name}`, () => {
		testCase.beforeTest?.();
		const resolvedAccountId = params.plugin.setup?.resolveAccountId?.({
			cfg: testCase.cfg,
			accountId: testCase.accountId,
			input: testCase.input
		}) ?? testCase.accountId ?? "default";
		expect(resolvedAccountId).toBe(testCase.expectedAccountId ?? resolvedAccountId);
		expect(params.plugin.setup?.validateInput?.({
			cfg: testCase.cfg,
			accountId: resolvedAccountId,
			input: testCase.input
		}) ?? null).toBe(testCase.expectedValidation ?? null);
		const nextCfg = params.plugin.setup?.applyAccountConfig({
			cfg: testCase.cfg,
			accountId: resolvedAccountId,
			input: testCase.input
		});
		expect(nextCfg).toBeDefined();
		const account = params.plugin.config.resolveAccount(nextCfg, resolvedAccountId);
		testCase.assertPatchedConfig?.(nextCfg);
		testCase.assertResolvedAccount?.(account, nextCfg);
	});
}
function installChannelStatusContractSuite(params) {
	it("exposes the base status contract", () => {
		expect(params.plugin.status).toBeDefined();
		expect(typeof params.plugin.status?.buildAccountSnapshot).toBe("function");
	});
	if (params.plugin.status?.defaultRuntime) it("status contract: default runtime is shaped like an account snapshot", () => {
		expect(typeof params.plugin.status?.defaultRuntime?.accountId).toBe("string");
	});
	for (const testCase of params.cases) it(`status contract: ${testCase.name}`, async () => {
		testCase.beforeTest?.();
		const account = params.plugin.config.resolveAccount(testCase.cfg, testCase.accountId);
		const snapshot = await params.plugin.status.buildAccountSnapshot({
			account,
			cfg: testCase.cfg,
			runtime: testCase.runtime,
			probe: testCase.probe
		});
		expect(typeof snapshot.accountId).toBe("string");
		expect(snapshot.accountId.trim()).not.toBe("");
		testCase.assertSnapshot?.(snapshot);
		if (params.plugin.status?.buildChannelSummary) {
			const defaultAccountId = params.plugin.config.defaultAccountId?.(testCase.cfg) ?? testCase.accountId ?? "default";
			const summary = await params.plugin.status.buildChannelSummary({
				account,
				cfg: testCase.cfg,
				defaultAccountId,
				snapshot
			});
			expect(summary).toEqual(expect.any(Object));
			testCase.assertSummary?.(summary);
		}
		if (testCase.expectedState && params.plugin.status?.resolveAccountState) expect(params.plugin.status.resolveAccountState({
			account,
			cfg: testCase.cfg,
			configured: testCase.resolveStateInput?.configured ?? true,
			enabled: testCase.resolveStateInput?.enabled ?? true
		})).toBe(testCase.expectedState);
	});
}
//#endregion
//#region src/plugin-sdk/test-helpers/plugin-runtime-mock.ts
const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-5.5";
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function mergeDeep(base, overrides) {
	const result = { ...base };
	for (const [key, overrideValue] of Object.entries(overrides)) {
		if (overrideValue === void 0) continue;
		const baseValue = result[key];
		if (isObject(baseValue) && isObject(overrideValue)) {
			result[key] = mergeDeep(baseValue, overrideValue);
			continue;
		}
		result[key] = overrideValue;
	}
	return result;
}
function createTaskFlowSessionMock() {
	return {
		sessionKey: "agent:main:main",
		createManaged: vi.fn(),
		get: vi.fn(),
		list: vi.fn(() => []),
		findLatest: vi.fn(),
		resolve: vi.fn(),
		getTaskSummary: vi.fn(),
		setWaiting: vi.fn(),
		resume: vi.fn(),
		finish: vi.fn(),
		fail: vi.fn(),
		requestCancel: vi.fn(),
		cancel: vi.fn(),
		runTask: vi.fn()
	};
}
function createDeprecatedRuntimeConfigError(name) {
	return /* @__PURE__ */ new Error(`Plugin runtime config.${name}() is deprecated in tests; pass cfg/current() or use mutateConfigFile()/replaceConfigFile().`);
}
function createPluginRuntimeMediaMock(overrides = {}) {
	const readRemoteMediaBuffer = vi.fn();
	return {
		readRemoteMediaBuffer,
		fetchRemoteMedia: readRemoteMediaBuffer,
		saveRemoteMedia: vi.fn().mockResolvedValue({
			path: "/tmp/test-media.jpg",
			contentType: "image/jpeg"
		}),
		saveResponseMedia: vi.fn().mockResolvedValue({
			path: "/tmp/test-media.jpg",
			contentType: "image/jpeg"
		}),
		saveMediaBuffer: vi.fn().mockResolvedValue({
			path: "/tmp/test-media.jpg",
			contentType: "image/jpeg"
		}),
		...overrides
	};
}
function createPluginRuntimeMock(overrides = {}) {
	const taskFlow = {
		bindSession: vi.fn(createTaskFlowSessionMock),
		fromToolContext: vi.fn(createTaskFlowSessionMock)
	};
	const dispatchAssembledChannelTurnMock = vi.fn(async (params) => {
		const ctxPayload = params.ctxPayload;
		const record = params.record;
		const recordInboundSession = params.recordInboundSession;
		const routeSessionKey = params.routeSessionKey;
		const storePath = params.storePath;
		const delivery = params.delivery;
		const ctxSessionKey = ctxPayload.SessionKey;
		const sessionKey = typeof ctxSessionKey === "string" ? ctxSessionKey : routeSessionKey;
		const dispatchReplyWithBufferedBlockDispatcher = params.dispatchReplyWithBufferedBlockDispatcher;
		await recordInboundSession({
			storePath,
			sessionKey,
			ctx: ctxPayload,
			groupResolution: record?.groupResolution,
			createIfMissing: record?.createIfMissing,
			updateLastRoute: record?.updateLastRoute,
			onRecordError: record?.onRecordError ?? (() => void 0),
			trackSessionMetaTask: record?.trackSessionMetaTask
		});
		const dispatchResult = await dispatchReplyWithBufferedBlockDispatcher({
			ctx: ctxPayload,
			cfg: params.cfg,
			dispatcherOptions: {
				...params.dispatcherOptions,
				deliver: async (payload, info) => {
					await delivery.deliver(payload, info);
				},
				onError: delivery.onError
			},
			replyOptions: params.replyOptions,
			replyResolver: params.replyResolver
		});
		return {
			admission: params.admission ?? { kind: "dispatch" },
			dispatched: true,
			ctxPayload,
			routeSessionKey,
			dispatchResult
		};
	});
	const runPreparedChannelTurnMock = vi.fn(async (params) => {
		try {
			await params.recordInboundSession({
				storePath: params.storePath,
				sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
				ctx: params.ctxPayload,
				groupResolution: params.record?.groupResolution,
				createIfMissing: params.record?.createIfMissing,
				updateLastRoute: params.record?.updateLastRoute,
				onRecordError: params.record?.onRecordError ?? (() => void 0),
				trackSessionMetaTask: params.record?.trackSessionMetaTask
			});
		} catch (err) {
			try {
				await params.onPreDispatchFailure?.(err);
			} catch {}
			throw err;
		}
		const admission = params.admission ?? { kind: "dispatch" };
		const dispatchResult = admission.kind === "observeOnly" ? params.observeOnlyDispatchResult ?? {
			queuedFinal: false,
			counts: {
				tool: 0,
				block: 0,
				final: 0
			}
		} : await params.runDispatch();
		return {
			admission,
			dispatched: true,
			ctxPayload: params.ctxPayload,
			routeSessionKey: params.routeSessionKey,
			dispatchResult
		};
	});
	const runChannelTurnMock = vi.fn(async (params) => {
		const input = await params.adapter.ingest(params.raw);
		if (!input) return {
			admission: {
				kind: "drop",
				reason: "ingest-null"
			},
			dispatched: false
		};
		const eventClass = await params.adapter.classify?.(input) ?? {
			kind: "message",
			canStartAgentTurn: true
		};
		if (!eventClass.canStartAgentTurn) return {
			admission: {
				kind: "handled",
				reason: `event:${eventClass.kind}`
			},
			dispatched: false
		};
		const preflightValue = await params.adapter.preflight?.(input, eventClass);
		const preflight = preflightValue && "kind" in preflightValue ? { admission: preflightValue } : preflightValue ?? {};
		if (preflight.admission && preflight.admission.kind !== "dispatch" && preflight.admission.kind !== "observeOnly") return {
			admission: preflight.admission,
			dispatched: false
		};
		const resolved = await params.adapter.resolveTurn(input, eventClass, preflight ?? {});
		const admission = resolved.admission ?? preflight.admission ?? { kind: "dispatch" };
		const result = {
			..."runDispatch" in resolved ? await runPreparedChannelTurnMock({
				...resolved,
				admission
			}) : await dispatchAssembledChannelTurnMock({
				...resolved,
				admission,
				delivery: admission.kind === "observeOnly" ? { deliver: async () => ({ visibleReplySent: false }) } : resolved.delivery
			}),
			admission
		};
		await params.adapter.onFinalize?.(result);
		return result;
	});
	const buildChannelInboundEventContextMock = vi.fn((params) => ({
		Body: params.message.body ?? params.message.rawBody,
		BodyForAgent: params.message.bodyForAgent ?? params.message.rawBody,
		RawBody: params.message.rawBody,
		CommandBody: params.message.commandBody ?? params.message.rawBody,
		BodyForCommands: params.message.commandBody ?? params.message.rawBody,
		From: params.from,
		To: params.reply.to,
		SessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
		AccountId: params.route.accountId ?? params.accountId,
		MessageSid: params.messageId,
		MessageSidFull: params.messageIdFull,
		ReplyToId: params.reply.replyToId ?? params.supplemental?.quote?.id,
		ReplyToIdFull: params.reply.replyToIdFull ?? params.supplemental?.quote?.fullId,
		MediaPath: params.media?.[0]?.path,
		MediaUrl: params.media?.[0]?.url ?? params.media?.[0]?.path,
		MediaType: params.media?.[0]?.contentType ?? params.media?.[0]?.kind,
		ChatType: params.conversation.kind,
		ConversationLabel: params.conversation.label,
		SenderName: params.sender.name ?? params.sender.displayLabel,
		SenderId: params.sender.id,
		SenderUsername: params.sender.username,
		Timestamp: params.timestamp,
		WasMentioned: params.access?.mentions?.wasMentioned,
		GroupSystemPrompt: params.supplemental?.groupSystemPrompt,
		Provider: params.provider ?? params.channel,
		Surface: params.surface ?? params.provider ?? params.channel,
		OriginatingChannel: params.channel,
		OriginatingTo: params.reply.originatingTo,
		CommandAuthorized: params.access?.commands ? params.access.commands.authorized ?? params.access.commands.authorizers?.some((entry) => entry.allowed) ?? false : false,
		...params.extra
	}));
	return mergeDeep({
		version: "1.0.0-test",
		config: {
			current: vi.fn(() => ({})),
			mutateConfigFile: vi.fn(async () => ({
				path: "/tmp/openclaw.json",
				previousHash: null,
				persistedHash: null,
				snapshot: {},
				nextConfig: {},
				afterWrite: { mode: "auto" },
				followUp: {
					mode: "auto",
					requiresRestart: false
				},
				result: void 0
			})),
			replaceConfigFile: vi.fn(async ({ nextConfig }) => ({
				path: "/tmp/openclaw.json",
				previousHash: null,
				persistedHash: null,
				snapshot: {},
				nextConfig,
				afterWrite: { mode: "auto" },
				followUp: {
					mode: "auto",
					requiresRestart: false
				}
			})),
			loadConfig: vi.fn(() => {
				throw createDeprecatedRuntimeConfigError("loadConfig");
			}),
			writeConfigFile: vi.fn(async () => {
				throw createDeprecatedRuntimeConfigError("writeConfigFile");
			})
		},
		agent: {
			defaults: {
				model: DEFAULT_MODEL,
				provider: DEFAULT_PROVIDER
			},
			resolveAgentDir: vi.fn(() => "/tmp/agent"),
			resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
			resolveAgentIdentity: vi.fn(() => ({ name: "test-agent" })),
			resolveThinkingDefault: vi.fn(() => "off"),
			normalizeThinkingLevel: vi.fn((raw) => raw),
			resolveThinkingPolicy: vi.fn(() => ({ levels: [
				{
					id: "off",
					label: "off"
				},
				{
					id: "minimal",
					label: "minimal"
				},
				{
					id: "low",
					label: "low"
				},
				{
					id: "medium",
					label: "medium"
				},
				{
					id: "high",
					label: "high"
				}
			] })),
			runEmbeddedPiAgent: vi.fn().mockResolvedValue({
				payloads: [],
				meta: {}
			}),
			runEmbeddedAgent: vi.fn().mockResolvedValue({
				payloads: [],
				meta: {}
			}),
			resolveAgentTimeoutMs: vi.fn(() => 3e4),
			ensureAgentWorkspace: vi.fn().mockResolvedValue(void 0),
			session: {
				resolveStorePath: vi.fn(() => "/tmp/agent-sessions.json"),
				loadSessionStore: vi.fn(() => ({})),
				getSessionEntry: vi.fn(() => void 0),
				listSessionEntries: vi.fn(() => []),
				patchSessionEntry: vi.fn().mockResolvedValue(null),
				upsertSessionEntry: vi.fn().mockResolvedValue(void 0),
				saveSessionStore: vi.fn().mockResolvedValue(void 0),
				updateSessionStore: vi.fn().mockResolvedValue(void 0),
				updateSessionStoreEntry: vi.fn().mockResolvedValue(null),
				resolveSessionFilePath: vi.fn((sessionId) => `/tmp/${sessionId}.json`)
			}
		},
		system: {
			enqueueSystemEvent: vi.fn(),
			requestHeartbeat: vi.fn(),
			requestHeartbeatNow: vi.fn(),
			runHeartbeatOnce: vi.fn(async () => ({
				status: "ran",
				durationMs: 0
			})),
			runCommandWithTimeout: vi.fn(),
			formatNativeDependencyHint: vi.fn(() => "")
		},
		media: {
			loadWebMedia: vi.fn(),
			detectMime: vi.fn(),
			mediaKindFromMime: vi.fn(),
			isVoiceCompatibleAudio: vi.fn(),
			getImageMetadata: vi.fn(),
			resizeToJpeg: vi.fn()
		},
		tts: {
			textToSpeech: vi.fn(),
			textToSpeechStream: vi.fn(),
			textToSpeechTelephony: vi.fn(),
			listVoices: vi.fn()
		},
		mediaUnderstanding: {
			runFile: vi.fn(),
			describeImageFile: vi.fn(),
			describeImageFileWithModel: vi.fn(),
			extractStructuredWithModel: vi.fn(),
			describeVideoFile: vi.fn(),
			transcribeAudioFile: vi.fn()
		},
		imageGeneration: {
			generate: vi.fn(),
			listProviders: vi.fn()
		},
		musicGeneration: {
			generate: vi.fn(),
			listProviders: vi.fn()
		},
		videoGeneration: {
			generate: vi.fn(),
			listProviders: vi.fn()
		},
		webSearch: {
			listProviders: vi.fn(),
			search: vi.fn()
		},
		stt: { transcribeAudioFile: vi.fn() },
		channel: {
			text: {
				chunkByNewline: vi.fn((text) => text ? [text] : []),
				chunkMarkdownText: vi.fn((text) => [text]),
				chunkMarkdownTextWithMode: vi.fn((text) => text ? [text] : []),
				chunkText: vi.fn((text) => text ? [text] : []),
				chunkTextWithMode: vi.fn((text) => text ? [text] : []),
				resolveChunkMode: vi.fn(() => "length"),
				resolveTextChunkLimit: vi.fn(() => 4e3),
				hasControlCommand: vi.fn(() => false),
				resolveMarkdownTableMode: vi.fn(() => "code"),
				convertMarkdownTables: vi.fn((text) => text)
			},
			reply: {
				dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => void 0),
				createReplyDispatcherWithTyping: vi.fn(),
				resolveEffectiveMessagesConfig: vi.fn(),
				resolveHumanDelayConfig: vi.fn(),
				dispatchReplyFromConfig: vi.fn(),
				settleReplyDispatcher: vi.fn(async ({ dispatcher, onSettled }) => {
					dispatcher.markComplete();
					try {
						await dispatcher.waitForIdle();
					} finally {
						await onSettled?.();
					}
				}),
				withReplyDispatcher: vi.fn(async ({ dispatcher, run, onSettled }) => {
					try {
						return await run();
					} finally {
						dispatcher.markComplete();
						try {
							await dispatcher.waitForIdle();
						} finally {
							await onSettled?.();
						}
					}
				}),
				finalizeInboundContext: vi.fn((ctx) => ctx),
				formatAgentEnvelope: vi.fn((opts) => opts.body),
				formatInboundEnvelope: vi.fn((opts) => opts.body),
				resolveEnvelopeFormatOptions: vi.fn(() => ({ template: "channel+name+time" }))
			},
			routing: {
				buildAgentSessionKey: vi.fn(({ agentId, channel, peer }) => `agent:${agentId}:${channel}:${peer?.kind ?? "direct"}:${peer?.id ?? "peer"}`),
				resolveAgentRoute: vi.fn(() => ({
					agentId: "main",
					accountId: "default",
					sessionKey: "agent:main:test:dm:peer"
				}))
			},
			pairing: {
				buildPairingReply: vi.fn(() => "Pairing code: TESTCODE"),
				readAllowFromStore: vi.fn().mockResolvedValue([]),
				upsertPairingRequest: vi.fn().mockResolvedValue({
					code: "TESTCODE",
					created: true
				})
			},
			media: createPluginRuntimeMediaMock(),
			session: {
				resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
				readSessionUpdatedAt: vi.fn(() => void 0),
				recordSessionMetaFromInbound: vi.fn(),
				recordInboundSession: vi.fn(),
				updateLastRoute: vi.fn()
			},
			mentions: {
				buildMentionRegexes: vi.fn(() => [/\bbert\b/i]),
				matchesMentionPatterns: vi.fn((text, regexes) => regexes.some((regex) => regex.test(text))),
				matchesMentionWithExplicit: vi.fn((params) => params.explicitWasMentioned === true ? true : params.mentionRegexes.some((regex) => regex.test(params.text))),
				implicitMentionKindWhen,
				resolveInboundMentionDecision
			},
			reactions: {
				createAckReactionHandle,
				shouldAckReaction,
				removeAckReactionAfterReply,
				removeAckReactionHandleAfterReply
			},
			groups: {
				resolveGroupPolicy: vi.fn(() => "open"),
				resolveRequireMention: vi.fn(() => false)
			},
			debounce: {
				createInboundDebouncer: vi.fn((params) => ({
					enqueue: async (item) => {
						await params.onFlush([item]);
					},
					flushKey: vi.fn(),
					cancelKey: vi.fn(() => false)
				})),
				resolveInboundDebounceMs: vi.fn((params) => {
					const p = params;
					const override = typeof p?.overrideMs === "number" ? p.overrideMs : void 0;
					if (typeof override === "number") return override;
					const inbound = p?.cfg?.messages?.inbound;
					const perChannel = p?.channel && inbound?.byChannel ? inbound.byChannel[p.channel] : void 0;
					if (typeof perChannel === "number") return perChannel;
					if (typeof inbound?.debounceMs === "number") return inbound.debounceMs;
					return 0;
				})
			},
			commands: {
				resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
				isControlCommandMessage: vi.fn(),
				shouldComputeCommandAuthorized: vi.fn(),
				shouldHandleTextCommands: vi.fn()
			},
			outbound: { loadAdapter: vi.fn() },
			turn: {
				run: runChannelTurnMock,
				runAssembled: dispatchAssembledChannelTurnMock,
				runResolved: vi.fn(async (params) => await runChannelTurnMock({
					channel: params.channel,
					accountId: params.accountId,
					raw: params.raw,
					log: params.log,
					adapter: {
						ingest: (raw) => typeof params.input === "function" ? params.input(raw) : params.input,
						resolveTurn: params.resolveTurn
					}
				})),
				buildContext: buildChannelInboundEventContextMock,
				runPrepared: runPreparedChannelTurnMock,
				dispatchAssembled: dispatchAssembledChannelTurnMock
			},
			threadBindings: {
				setIdleTimeoutBySessionKey: vi.fn(),
				setMaxAgeBySessionKey: vi.fn()
			},
			runtimeContexts: {
				register: vi.fn(({ abortSignal }) => {
					const lease = { dispose: vi.fn() };
					abortSignal?.addEventListener("abort", lease.dispose, { once: true });
					return lease;
				}),
				get: vi.fn(),
				watch: vi.fn(() => vi.fn())
			},
			activity: {}
		},
		events: {
			onAgentEvent: vi.fn(() => () => {}),
			onSessionTranscriptUpdate: vi.fn(() => () => {})
		},
		logging: {
			shouldLogVerbose: vi.fn(() => false),
			getChildLogger: vi.fn(() => ({
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn()
			}))
		},
		state: {
			resolveStateDir: vi.fn(() => "/tmp/openclaw"),
			openKeyedStore: vi.fn(() => {
				throw new Error("openKeyedStore mock is not configured");
			})
		},
		tasks: {
			runs: {
				bindSession: vi.fn(),
				fromToolContext: vi.fn()
			},
			flows: {
				bindSession: vi.fn(),
				fromToolContext: vi.fn()
			},
			managedFlows: taskFlow,
			flow: taskFlow
		},
		taskFlow,
		modelAuth: {
			getApiKeyForModel: vi.fn(),
			getRuntimeAuthForModel: vi.fn(),
			resolveApiKeyForProvider: vi.fn()
		},
		subagent: {
			run: vi.fn(),
			waitForRun: vi.fn(),
			getSessionMessages: vi.fn(),
			getSession: vi.fn(),
			deleteSession: vi.fn()
		},
		llm: { complete: vi.fn() },
		nodes: {
			list: vi.fn(async () => ({ nodes: [] })),
			invoke: vi.fn()
		}
	}, overrides);
}
//#endregion
//#region src/plugin-sdk/test-helpers/send-config.ts
function expectProvidedCfgSkipsRuntimeLoad({ loadConfig, resolveAccount, cfg, accountId }) {
	expect(loadConfig).not.toHaveBeenCalled();
	expect(resolveAccount).toHaveBeenCalledWith({
		cfg,
		accountId
	});
}
function expectRuntimeCfgFallback({ loadConfig, resolveAccount, cfg, accountId }) {
	expect(loadConfig).toHaveBeenCalledTimes(1);
	expect(resolveAccount).toHaveBeenCalledWith({
		cfg,
		accountId
	});
}
function createSendCfgThreadingRuntime({ loadConfig, resolveMarkdownTableMode, convertMarkdownTables, record }) {
	return {
		config: { loadConfig },
		channel: {
			text: {
				resolveMarkdownTableMode,
				convertMarkdownTables
			},
			activity: { record }
		}
	};
}
//#endregion
//#region src/plugin-sdk/test-helpers/start-account-context.ts
function createStartAccountContext(params) {
	const snapshot = {
		accountId: params.account.accountId,
		configured: true,
		enabled: true,
		running: false
	};
	return {
		accountId: params.account.accountId,
		account: params.account,
		cfg: params.cfg ?? {},
		runtime: params.runtime ?? createRuntimeEnv(),
		abortSignal: params.abortSignal ?? new AbortController().signal,
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn()
		},
		getStatus: () => snapshot,
		setStatus: (next) => {
			Object.assign(snapshot, next);
			params.statusPatchSink?.(snapshot);
		}
	};
}
//#endregion
//#region src/plugin-sdk/test-helpers/start-account-lifecycle.ts
function startAccountAndTrackLifecycle(params) {
	const patches = [];
	const abort = new AbortController();
	const task = params.startAccount(createStartAccountContext({
		account: params.account,
		abortSignal: abort.signal,
		statusPatchSink: (next) => patches.push({ ...next })
	}));
	let settled = false;
	task.then(() => {
		settled = true;
	});
	return {
		abort,
		patches,
		task,
		isSettled: () => settled
	};
}
async function abortStartedAccount(params) {
	params.abort.abort();
	await params.task;
}
function waitForStartedMocks(...mocks) {
	return async () => {
		await vi.waitFor(() => {
			for (const mock of mocks) expect(mock).toHaveBeenCalledOnce();
		});
	};
}
function expectLifecyclePatch(patches, expected) {
	expect(patches).toContainEqual(expect.objectContaining(expected));
}
async function expectPendingUntilAbort(params) {
	await params.waitForStarted();
	expect(params.isSettled()).toBe(false);
	params.assertBeforeAbort?.();
	await abortStartedAccount({
		abort: params.abort,
		task: params.task
	});
	params.assertAfterAbort?.();
}
async function expectStopPendingUntilAbort(params) {
	await expectPendingUntilAbort({
		waitForStarted: params.waitForStarted,
		isSettled: params.isSettled,
		abort: params.abort,
		task: params.task,
		assertBeforeAbort: () => {
			expect(params.stop).not.toHaveBeenCalled();
		},
		assertAfterAbort: () => {
			expect(params.stop).toHaveBeenCalledOnce();
		}
	});
}
//#endregion
//#region src/plugin-sdk/test-helpers/status-issues.ts
function expectOpenDmPolicyConfigIssue(params) {
	const issues = params.collectIssues([params.account]);
	expect(issues).toHaveLength(1);
	expect(issues[0]?.kind).toBe("config");
}
//#endregion
//#region src/plugin-sdk/test-helpers/subagent-hooks.ts
function registerHookHandlersForTest(params) {
	const handlers = /* @__PURE__ */ new Map();
	const api = {
		config: params.config,
		on: (hookName, handler) => {
			handlers.set(hookName, handler);
		}
	};
	params.register(api);
	return handlers;
}
function getRequiredHookHandler(handlers, hookName) {
	const handler = handlers.get(hookName);
	if (!handler) throw new Error(`expected ${hookName} hook handler`);
	return handler;
}
//#endregion
//#region src/plugin-sdk/test-helpers/bundled-channel-entry.ts
function assertBundledChannelEntries(params) {
	it(params.channelMessage ?? "declares the channel plugin without importing the broad api barrel", () => {
		expect(params.entry.kind).toBe("bundled-channel-entry");
		expect(params.entry.id).toBe(params.expectedId);
		expect(params.entry.name).toBe(params.expectedName);
	});
	it(params.setupMessage ?? "declares the setup plugin without importing the broad api barrel", () => {
		expect(params.setupEntry.kind).toBe("bundled-channel-setup-entry");
		expect(typeof params.setupEntry.loadSetupPlugin).toBe("function");
	});
}
//#endregion
//#region src/plugin-sdk/test-helpers/envelope-timestamp.ts
function formatEnvelopeTimestamp(date, zone = "utc") {
	const trimmedZone = zone.trim();
	const normalized = trimmedZone.toLowerCase();
	const weekday = (() => {
		try {
			if (normalized === "utc" || normalized === "gmt") return new Intl.DateTimeFormat("en-US", {
				timeZone: "UTC",
				weekday: "short"
			}).format(date);
			if (normalized === "local" || normalized === "host") return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
			return new Intl.DateTimeFormat("en-US", {
				timeZone: trimmedZone,
				weekday: "short"
			}).format(date);
		} catch {
			return;
		}
	})();
	if (normalized === "utc" || normalized === "gmt") {
		const ts = formatUtcTimestamp(date);
		return weekday ? `${weekday} ${ts}` : ts;
	}
	if (normalized === "local" || normalized === "host") {
		const ts = formatZonedTimestamp(date) ?? formatUtcTimestamp(date);
		return weekday ? `${weekday} ${ts}` : ts;
	}
	const ts = formatZonedTimestamp(date, { timeZone: trimmedZone }) ?? formatUtcTimestamp(date);
	return weekday ? `${weekday} ${ts}` : ts;
}
function formatLocalEnvelopeTimestamp(date) {
	return formatEnvelopeTimestamp(date, "local");
}
//#endregion
//#region src/plugin-sdk/test-helpers/pairing-reply.ts
function extractPairingCode(text) {
	const code = text.match(/Pairing code:\s*```[\r\n]+([A-Z2-9]{6,})/)?.[1];
	expect(code).toBeDefined();
	return code ?? "";
}
function expectPairingReplyText(text, params) {
	const code = params.code ?? extractPairingCode(text);
	expect(text).toContain("OpenClaw: access not configured.");
	expect(text).toContain(params.idLine);
	expect(text).toContain("Pairing code:");
	expect(text).toContain(`\n\`\`\`\n${code}\n\`\`\`\n`);
	expect(text).toContain(`pairing approve ${params.channel} ${code}`);
	return code;
}
//#endregion
export { abortStartedAccount, addTestHook, assertBundledChannelEntries, createDirectoryTestRuntime, createEmptyPluginRegistry, createOutboundTestPlugin, createPluginRuntimeMediaMock, createPluginRuntimeMock, createSendCfgThreadingRuntime, createStartAccountContext, createTestRegistry, deliverOutboundPayloads, escapeRegExp, expectChannelPluginContract, expectDirectoryIds, expectDirectorySurface, expectLifecyclePatch, expectOpenDmPolicyConfigIssue, expectPairingReplyText, expectPendingUntilAbort, expectProvidedCfgSkipsRuntimeLoad, expectRuntimeCfgFallback, expectStopPendingUntilAbort, extractPairingCode, formatEnvelopeTimestamp, formatLocalEnvelopeTimestamp, getRequiredHookHandler, initializeGlobalHookRunner, installChannelActionsContractSuite, installChannelPluginContractSuite, installChannelSetupContractSuite, installChannelStatusContractSuite, registerHookHandlersForTest, releasePinnedPluginChannelRegistry, resetGlobalHookRunner, setActivePluginRegistry, startAccountAndTrackLifecycle, stripAnsi, waitForStartedMocks };
