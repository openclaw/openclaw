# OpenClaw docs map

Generated from `docs/docs.json` by `pnpm docs:skill-map:gen`. Do not edit by hand.
Page `x/y` is `<docs>/x/y.md` locally and `https://docs.openclaw.ai/x/y` on the web.
Pages marked (web only) are published but not shipped in local docs.

## Get started

- Overview: index start/{why-openclaw,hubs,docs-directory} start/why-openclaw/{the-trust-boundary,policy-as-code,identity-and-roles,secrets,versioned-state-guarded-upgrades,provenance,openclaw-and-hermes-agent} concepts/features
- First steps: start/{getting-started,onboarding-overview,wizard,onboarding}
- Setup guides and reference: start/{openclaw,multiplayer,wizard-cli-reference,wizard-cli-automation}

## Install

- Install overview: install/{index,installer}
- Runtimes: install/{node,node-compatibility,bun,bun-compatibility,standalone,nix}
- Maintenance: install/{backups,updating,update-troubleshooting,migrating,migrating-claude,migrating-hermes,uninstall,development-channels} install/updating/{update-methods,automatic-updates,rollback-and-recovery} prose
- Containers: install/{docker,podman} install/docker/{environment-variables,networking-and-storage,compose-operations,sandbox-and-troubleshooting}
- Hosting: vps install/{boat,cloudflare,daytona,exe-dev,fly,northflank,railway,render,upstash,azure,digitalocean,gcp,hetzner,hostinger,oracle,ansible,docker-vm-runtime,jetson,kubernetes,macos-vm,raspberry-pi}
- Advanced setup: start/setup

## Channels

- Overview: channels/index
- Mainstream messaging: channels/{discord,discord-activities,googlechat,imessage,imessage-from-bluebubbles,matrix,matrix-migration,matrix-presentation,matrix-push-rules,msteams,signal,slack,sms,telegram,whatsapp,x} channels/discord/{setup,access-control,messaging,threads-and-sessions,rich-messages,events,voice-channels,voice-transcripts,voice-follow,troubleshooting} channels/imessage/{setup,private-api,access-control,deployment,media,rich-messages,messaging,troubleshooting} announcements/bluebubbles-imessage channels/matrix/{setup,access-control,messaging,rich-messages,encryption,threads-and-sessions,accounts-and-homeservers} channels/msteams/{setup,access-control,authentication,manifest-and-permissions,configuration,messaging,cards-and-actions,troubleshooting} channels/slack/{setup,transports,enterprise-grid,manifest-and-scopes,access-control,threads-and-sessions,messaging,media,rich-messages,events,troubleshooting} channels/telegram/{setup,access-control,messaging,threads-and-sessions,rich-messages,media,events,transports,mini-app,troubleshooting}
- Developer and self-hosted: channels/{a2a,buzz,clickclack,irc,mattermost,nextcloud-talk,nostr,raft,reef,synology-chat,tlon,twitch}
- Regional platforms: channels/{feishu,line,qqbot,wechat,wecom,yuanbao,zalo,zaloclawbot,zalouser} channels/feishu/{setup,access-control,advanced-configuration,dynamic-agents,messaging,configuration-reference,troubleshooting}
- Configuration: channels/{pairing,access-groups,bot-loop-protection,groups,group-messages,ambient-room-events,broadcast-groups,channel-routing,location,troubleshooting}

## Agents

- Agent runtime: concepts/{agents-and-templates,architecture,agent,agent-loop,agent-runtimes,system-prompt,context,context-engine,soul}
- Agent workspace: concepts/{agent-workspace,managed-worktrees,storage-locations,oauth,experimental-features} start/bootstrapping
- Sessions and memory: concepts/{main-session,multi-user,session,session-controller,session-attachment,session-search,session-pruning,session-state,session-tool,memory,memory-architecture,memory-provenance,user-model,standing-intents,memory-builtin,memory-honcho,memory-search,active-memory,dreaming,compaction} concepts/active-memory/{enabling,how-it-works,session-controls,tuning,memory-tools,advanced-options,configuration,recommended-setup,troubleshooting}
- Multi-agent: concepts/{multi-agent,agent-bindings,parallel-specialist-lanes,presence,delegate-architecture}
- Messages and delivery: concepts/{messages,streaming,typing-indicators,progress-drafts,retry,queue,queue-steering}

## Capabilities

- Overview: tools/index
- Plugins: tools/plugin plugins/{manage-plugins,community,bundles}
- Plugin guides: plugins/{agent-guidance,agentsapi,codex-computer-use,codex-harness,codex-native-plugins,codex-supervision,copilot,muse,meeting-plugins,facetime,facetime-recovery,google-meet,teams-meetings,slack-huddles,voice-call,zoom-meetings,apple-fm,gbrain,knowledge,llama-cpp,memory-lancedb,memory-wiki,onnx,subq,typesafe,onepassword,vault,admin-http-rpc,beam,cloudflare,geolocation,logbook,mcp-relay,oc-path,session-share,workboard,zalouser} plugins/codex-harness/{placement,routing,configuration,app-server,config-fields,commands,runtime-behavior,native-features,troubleshooting} specs/codex-supervision plugins/google-meet/{transports,oauth-and-artifacts,config,tool-and-modes,troubleshooting} plugins/voice-call/{configuration,realtime-and-streaming,tts-and-inbound-calls,security-and-interfaces,troubleshooting} plugins/knowledge/{stores-and-access,memory-provider,tools,records-and-ontology,retrieval,evidence,ingestion,corrections,local-history,maintenance,scribes,control-ui}
- Building plugins: plugins/{building-plugins,runtime-compatibility,feature-plugins,tool-plugins,sdk-channel-plugins,sdk-provider-plugins,cli-backend-plugins,hooks,plugin-permission-requests,adding-capabilities} plugins/sdk-channel-plugins/{message-adapter,durable-ingress,status-and-media,sessions-and-bindings,approvals,setup-and-config,mention-policy} plugins/sdk-provider-plugins/{model-catalogs,hook-families,runtime-hooks,voice-and-audio,media-and-search} plugins/hooks/{reference,tool-policy,prompt-and-session,messages,lifecycle}
- Skills: tools/{skills,custodian-skills,skill-workshop,self-learning,creating-skills,skills-config,slash-commands} tools/skill-workshop/personal-library
- Automation: automation/{index,cron-jobs,imap,mcp-events,standing-orders,hooks} gateway/heartbeat automation/cron-jobs/{how-it-works,schedules,payloads,delivery,managing-jobs,webhooks,gmail,troubleshooting} automation/hooks/{writing-hooks,configuration,bundled-hooks,event-types,troubleshooting}
- Tools: tools/{apply-patch,code-execution,diffs,elevated,exec,exec-approvals,exec-approvals-advanced,permission-modes,secrets,media-overview,image-generation,music-generation,pdf,tts,video-generation,code-mode,autoreview,llm-task,lobster,mcp,session-project,tool-search,loop-detection,thinking,tokenjuice,trajectory,ask-user,btw,progress-card,reactions,screen,show-widget,theme,browser,browser-control,browser-linux-troubleshooting,browser-login,browser-wsl2-windows-remote-cdp-troubleshooting,chrome-extension,firecrawl,web-fetch,web,deep-research,brave-search,duckduckgo-search,exa-search,gemini-search,grok-search,kimi-search,minimax-search,ollama-search,parallel-search,perplexity-search,searxng-search,tavily} tools/tts/{quickstart,configuration,personas,commands,output,field-reference,api} tools/code-mode/{quickstart,executors,configuration,tool-surface,guest-api,output,internals,troubleshooting,maintainers} tools/browser/{setup,profiles,existing-session,configuration,remote,lightweight,security,isolation,agent-tools,troubleshooting}
- Agent coordination: tools/{agent-send,goal,steer,subagents,swarm,acp-agents,acp-agents-setup,multi-agent-sandbox-tools} tools/subagents/{slash-command,tool-reference,thread-bound-sessions,nesting,announce,tool-policy,operations} tools/acp-agents/{quickstart,runbook,bindings,sessions,delivery,controls,troubleshooting}

## ClawHub

- Overview: (web only: clawhub/{index,quickstart,how-it-works})
- Using ClawHub: (web only: clawhub/{cli,publishing,skill-format,auth,telemetry,troubleshooting})
- API and trust: (web only: clawhub/{api,http-api,acceptable-usage,moderation,security-audits})

## Models

- Overview: providers/{index,models}
- Concepts and configuration: concepts/{models,recommended-models,decision-models,model-providers,model-failover} concepts/model-providers/{quick-rules,control-ui-and-keys,official-provider-plugins,custom-providers}
- Providers: providers/{abliteration,alibaba,anthropic,arcee,baseten,bedrock,bedrock-mantle,cerebras,chutes,cohere,deepinfra,deepseek,featherless,fireworks,github-copilot,gmi,google,google-vertex,groq,huggingface,levanto,longcat,meta,minimax,mistral,moonshot,novita,nvidia,ollama-cloud,openai,opencode,opencode-go,particle,perplexity-provider,poolside,qianfan,qwen,radius,stepfun,synthetic,telnyx,tencent,together,venice,volcengine,xai,xiaomi,zai,celeris,fastino,liquid-ai,nace,rerank,azure-speech,deepgram,elevenlabs,fish-audio,gradium,inworld,senseaudio,comfy,fal,kie,pixverse,runway,vydra,bifrost,claude-max-api-proxy,clawrouter,cloudflare-ai-gateway,kilocode,liquid-inference,litellm,neon,openrouter,requesty,vercel-ai-gateway,ds4,llmman,lmstudio,ollama,omlx,sglang,vllm} plugins/reference/anthropic-vertex providers/openai/{setup,authentication,models,runtimes,coverage-and-cost,image-and-video,voice-and-speech,azure,advanced} providers/ollama/{setup,model-discovery,node-local-inference,vision,configuration,recipes,web-search,advanced,troubleshooting}

## Platforms

- Platforms overview: platforms/{index,macos,linux,omarchy,windows,android,chromeos,ios,ios-healthkit,easyrunner}
- macOS companion app: platforms/mac/{dev-setup,menu-bar,icon,permissions,signing,remote,bundled-gateway,health,logging,xpc,voicewake,voice-overlay,webchat,canvas,skills,peekaboo} reference/device-models

## Gateway & Ops

- Gateway: gateway/{index,configuration,configuration-reference,config-agents,config-automation,config-browser-ui-desktop,config-channels,config-cloud-workers,config-extensions,config-gateway,config-hooks,config-observability,config-runtime,config-secrets-env,config-tools,configuration-examples,authentication,secrets,1password,secrets-plan-contract,trusted-proxy-auth,health,postgresql,doctor,audit,telemetry,opentelemetry,prometheus,logging,diagnostics,troubleshooting,postgresql,gateway-lock,background-process,restart-recovery,cloud-sessions,cloud-workers,multiple-gateways,operator-scopes,sandboxing,openshell,sandbox-vs-tool-policy-vs-elevated,permission-modes,clients,external-apps,protocol,embedding,openai-http-api,openresponses-http-api,tools-invoke-http-api,cli-backends,local-models,local-model-services,pairing,discovery,bonjour} gateway/configuration/{common-tasks,hot-reload,config-rpc,environment-variables} gateway/config-agents/{workspace-and-bootstrap,models,runtime-and-cli-backends,heartbeat-compaction-and-streaming,sandbox,entries-and-multi-agent,sessions,messages-and-talk} gateway/config-channels/{shared-policies,personal-messaging,workplace-chat,community-chat,mention-gating-and-history,commands} gateway/config-tools/{tool-policy,github-identity,built-in-tools,sessions-and-subagents,custom-providers,provider-examples} auth-credential-semantics logging network gateway/secrets/{runtime-model,secretref-contract,secret-store-and-egress,integration-examples,operations} gateway/doctor/{running,checks,config-migrations,provider-repairs,state-and-sessions,gateway-and-services,workspace-and-dreams} gateway/opentelemetry/{setup,configuration,privacy-and-trace-context,model-calls-and-metrics,spans-and-events} gateway/troubleshooting/{updates-and-rollbacks,skills-and-model-providers,agent-replies-and-control-ui,gateway-service-and-process,config-validation-and-probes,channel-delivery-and-tools} gateway/cloud-workers/{warm-images,environment-file,per-project-default-profiles,setup-and-bundle-installation,verify-the-profile,dispatching-a-session,placement-and-machine-selection,session-lifecycle,desktop,security-model,native-inference,troubleshooting} gateway/security/{index,trust-model,running-the-audit,audit-checks,hardened-baseline,access-control,prompt-injection,tool-permissions,browser-control,network-exposure,secrets-and-storage,exposure-runbook,rate-limiting,operator-incident-response,secure-file-operations} gateway/sandboxing/{what-gets-sandboxed,modes-scope-and-backend,supported-capability-matrix,docker-backend,podman-backend,ssh-backend,openshell-backend,crabbox-backend,workspace-access,multiple-folders-for-one-agent,images-and-setup,setup-command} gateway/protocol/{transport,handshake,presence,rpc-methods,rpc-system-and-channels,rpc-talk-config-and-agents,rpc-session-control,rpc-devices-nodes-and-approvals,rpc-bootstrap-and-events,ledgers,operator-methods,versioning,auth}
- Remote access: gateway/{remote,stable-https-url,tailscale,cloudflare-access}
- Security: security/{network-proxy,formal-verification,incident-response,THREAT-MODEL-ATLAS,CONTRIBUTING-THREAT-MODEL} security/THREAT-MODEL-ATLAS/{reconnaissance,initial-access,execution,persistence,defense-evasion,discovery,collection-and-exfiltration,impact}
- Nodes and media: nodes/{index,pairing-and-status,node-host,node-exec,mcp-and-skills,session-hosting,session-catalogs,file-transfers,command-policy,device-commands,presence,troubleshooting,media-understanding,media-playback,images,audio,camera,computer-use,talk,voicewake,location-command} nodes/talk/{realtime-sessions,session-ownership,macos-relay,client-ui}
- Web interfaces: web/{index,control-ui,notifications,dashboard,dashboards,dashboard-architecture,urls,webchat,tui,lobster} web/control-ui/{connect-and-pair,sessions-and-sidebar,chat,panels,settings,feature-reference,offline-and-reconnect,security-model,development} gateway/portals

## Reference

- CLI commands: cli/{index,daemon,gateway,health,logs,status,backup,migrate,onboard,openclaw,reset,setup,storage,uninstall,update,doctor,secrets,security,triage,agent,agents,templates,infer,memory,models,promos,sessions,transcripts,wiki,audit,hooks,message,system,channels,directory,pairing,pair,qr,users,voicecall,approvals,browser,cron,connect,devices,id,node,nodes,sandbox,worker,config,configure,webhooks,plugins,file-transfer,path,policy,skills,workboard,attach,dashboard,resume,tui,acp,clawbot,completion,dns,docs,mcp,proxy} cli/gateway/{running,restart-and-supervision,query,service,discovery} cli/update/{status-and-history,repair-and-recovery,how-updates-run} cli/doctor/{running,recovery,lint,health-contract,state-migrations,sqlite-maintenance,checks} cli/plugins/{authoring,install,list,uninstall-and-update,inspect-and-diagnose,marketplace} cli/policy/{authoring,rules,scopes,running-checks,attestation,findings} cli/mcp/{serve,registry,json-output,transports,control-ui,apps}
- RPC and API: reference/rpc
- Codex runtime reference: plugins/{codex-harness-reference,codex-harness-runtime} plugins/codex-harness-reference/{supervision,app-server-transport,approval-and-sandbox,auth,dynamic-tools,timeouts,model-discovery,restricted-turns,workspace-bootstrap-files} plugins/codex-harness-runtime/{recovery,threads,replies,hooks,sandbox-streaming,v1-support-contract,permissions,queue-and-feedback,compaction}
- Plugin reference: plugins/{plugin-inventory,reference,dependency-resolution}
- Plugin SDK reference: plugins/{sdk-overview,manifest,sdk-subpaths,sdk-gateway-ingress,sdk-entrypoints,sdk-runtime,sdk-agent-harness,sdk-setup,sdk-testing} plugins/sdk-overview/{imports,capabilities,tools-and-commands,infrastructure,host-hooks,cli-and-discovery,memory-and-context,events-and-hooks} plugins/manifest/{models,providers,setup-and-auth,capabilities,surfaces,config-and-secrets,package-json} plugins/sdk-entrypoints/{tool-policy-and-sandbox,package-entries,define-tool-plugin,define-plugin-entry,native-providers,define-channel-plugin-entry,define-setup-plugin-entry,registration-mode} plugins/sdk-runtime/{config-and-utilities,agent,models,background-work,gateway-and-nodes,media,state-and-system,channel} plugins/sdk-agent-harness/{core-ownership,registration,selection-policy,attempt-runtime,user-input-and-execution,native-inventories,runtime-config,sessions-and-results}
- Plugin internals: plugins/{architecture,architecture-internals,sdk-migration,compatibility,install-overrides,sdk-channel-outbound,sdk-channel-inbound,sdk-channel-ingress,message-presentation} plugins/architecture-internals/{load-pipeline,provider-hooks,runtime-helpers,gateway-routes,channel-surfaces,packaging,context-engines,new-capability} plugins/sdk-migration/{how-to-migrate,sqlite-async,import-paths,removed-surfaces,talk,async-transcript-and-tts,compatibility-policy,removal-timeline}
- Templates: reference/AGENTS.default reference/templates/{AGENTS,BOOT,BOOTSTRAP,IDENTITY,SOUL,USER,AGENTS.dev,IDENTITY.dev,SOUL.dev,USER.dev,HEARTBEAT,TOOLS}
- Technical reference: agent-runtime-architecture openclaw-agent-runtime date-time reference/{openclaw-ai,token-use,api-usage-costs,prompt-caching,session-management-compaction,transcript-hygiene,memory-config,database-engines,database-schemas,rich-output-protocol,secretref-credential-surface,secret-placeholder-conventions} concepts/{usage-tracking,timezone} reference/session-management-compaction/{store,maintenance,schema,compaction,housekeeping,resident-history} reference/database-schemas/{layout,versioning,personal-data,storage-changes,agent-schema-history,state-schema-history,integrity-and-recovery}
- Schemas and formatting: concepts/{typebox,markdown-formatting}
- Project and contributing: reference/{credits,pull-request-review-flow} reference/scripts/{pr-preparation,pr-tooling,remote-gates,github-transport,prior-ci,merge-admission,merge-recovery}

## Releases

- Release notes: releases/{index,2026.11.6,2026.11.5,2026.11.4,2026.11.3,2026.11.2,2026.11.1,2026.10.10,2026.10.9,2026.10.8,2026.10.7,2026.10.6,2026.10.5,2026.10.4,2026.10.3,2026.10.2,2026.10.1,2026.9.9,2026.9.8,2026.9.7,2026.9.6,2026.9.5,2026.9.4,2026.9.3,2026.9.2,2026.9.1,2026.8.2,2026.8.1,2026.7.1,2026.6.11}
- Release process: reference/{RELEASING,full-release-validation,release-performance-sweep} reference/full-release-validation/{dispatch,continuation,extended-stable,stages,release-checks,profiles,evidence} gateway/security/dependency-locking

## Contributing

- Maturity: maturity/{scorecard,taxonomy}
- Testing and CI: reference/test reference/test/{local,lanes,docker,performance,runner-internals,remote-proof} ci ci/{pipeline,watching-runs,checkout,scope-and-routing,runners,capacity,release-validation,scheduled-workflows,local-proof} ci/scope-and-routing/{selection,node-test-lanes,job-budgets,manual-dispatches} ci/release-validation/{full-release-validation,live-and-e2e-shards,package-acceptance,install-smoke-and-docker-e2e,plugin-prerelease} help/{scripts,testing,testing-updates-plugins,testing-live} concepts/{qa-e2e-automation,personal-agent-benchmark-pack,mantis,mantis-slack-desktop-runbook} concepts/qa-e2e-automation/{command-surface,operator-flow,scenario-coverage,channel-qa-reference,slack-qa,whatsapp-and-credentials,extending-the-stack,qa-reporting} help/testing/{suites,live-workflows,docker,qa-runners,contracts,writing-tests} help/testing-live/{quick-smokes,model-smoke,cli-backends,acp-and-codex,long-context-and-matrix,media-providers}

## Help

- Start here: help/{index,support,troubleshooting,debugging}
- FAQ: help/{faq,faq-first-run,faq-models} help/faq/{what-is-openclaw,skills-and-automation,sandboxing-and-memory,where-things-live-on-disk,config-basics,remote-gateways-and-nodes,env-vars,sessions-and-chats,gateway-ports-and-remote-mode,logging-and-debugging,media-and-attachments,security-and-access-control,chat-commands-and-stopping} help/faq-first-run/{quick-start,providers-and-hosting}
- Diagnostics: help/environment diagnostics/flags
- Community and meta: start/lore
