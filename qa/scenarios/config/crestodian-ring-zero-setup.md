# Crestodian ring-zero setup

```yaml qa-scenario
id: crestodian-ring-zero-setup
title: Crestodian ring-zero setup
surface: config
coverage:
  primary:
    - config.crestodian-setup
  secondary:
    - channels.discord-config
    - agents.create
objective: Verify Crestodian can bootstrap a fresh OpenClaw config, set the default model, create an agent, configure Discord through a SecretRef, validate config, and leave an audit trail.
successCriteria:
  - Crestodian reports missing config in an empty state dir.
  - Crestodian setup writes a workspace and default model.
  - Crestodian creates a non-main agent with its own workspace and model.
  - Crestodian enables the Discord plugin before writing Discord channel config.
  - Crestodian configures Discord through an env SecretRef without persisting the raw token.
  - Config validation passes and audit entries exist for every applied write.
docsRefs:
  - docs/cli/crestodian.md
  - docs/channels/discord.md
  - docs/help/testing.md
codeRefs:
  - src/crestodian/operations.ts
  - scripts/e2e/crestodian-first-run-docker-client.ts
  - extensions/qa-lab/src/suite-runtime-agent-process.ts
execution:
  kind: flow
  summary: Drive the public Crestodian CLI in an isolated fresh state dir and verify setup/model/agent/Discord/audit results.
  config:
    stateDirName: crestodian-ring-zero-state
    defaultWorkspaceName: crestodian-main-workspace
    agentWorkspaceName: crestodian-reef-workspace
    agentId: reef
    model: openai/gpt-5.2
    discordEnv: DISCORD_BOT_TOKEN
    discordToken: openclaw-crestodian-qa-discord-token
```

```yaml qa-flow
steps:
  - name: bootstraps config through Crestodian CLI
    actions:
      - set: stateDir
        value:
          expr: "path.join(env.gateway.tempRoot, config.stateDirName)"
      - set: configPath
        value:
          expr: "path.join(stateDir, 'openclaw.json')"
      - set: defaultWorkspace
        value:
          expr: "path.join(env.gateway.tempRoot, config.defaultWorkspaceName)"
      - set: agentWorkspace
        value:
          expr: "path.join(env.gateway.tempRoot, config.agentWorkspaceName)"
      - set: crestodianEnv
        value:
          expr: "({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(env.repoRoot, 'dist', 'extensions'), [config.discordEnv]: config.discordToken })"
      - call: fs.rm
        args:
          - ref: stateDir
          - recursive: true
            force: true
      - call: fs.mkdir
        args:
          - ref: stateDir
          - recursive: true
      - call: runQaCli
        saveAs: overviewOutput
        args:
          - ref: env
          - - crestodian
            - -m
            - overview
          - timeoutMs: 60000
            env:
              ref: crestodianEnv
      - assert:
          expr: "String(overviewOutput).includes('Config: missing')"
          message:
            expr: "`fresh Crestodian overview did not report missing config: ${overviewOutput}`"
      - assert:
          expr: 'String(overviewOutput).includes(''Next: run "setup" to create a starter config'')'
          message:
            expr: "`fresh Crestodian overview did not recommend setup: ${overviewOutput}`"
      - call: runQaCli
        saveAs: setupOutput
        args:
          - ref: env
          - - crestodian
            - --yes
            - -m
            - expr: "`setup workspace ${defaultWorkspace} model ${config.model}`"
          - timeoutMs: 60000
            env:
              ref: crestodianEnv
      - assert:
          expr: "String(setupOutput).includes('[crestodian] done: crestodian.setup')"
          message:
            expr: "`Crestodian setup did not apply: ${setupOutput}`"
      - call: runQaCli
        saveAs: modelOutput
        args:
          - ref: env
          - - crestodian
            - --yes
            - -m
            - expr: "`set default model ${config.model}`"
          - timeoutMs: 60000
            env:
              ref: crestodianEnv
      - assert:
          expr: "String(modelOutput).includes('[crestodian] done: config.setDefaultModel')"
          message:
            expr: "`Crestodian model update did not apply: ${modelOutput}`"
      - call: runQaCli
        saveAs: agentOutput
        args:
          - ref: env
          - - crestodian
            - --yes
            - -m
            - expr: "`create agent ${config.agentId} workspace ${agentWorkspace} model ${config.model}`"
          - timeoutMs: 60000
            env:
              ref: crestodianEnv
      - assert:
          expr: "String(agentOutput).includes('[crestodian] done: agents.create')"
          message:
            expr: "`Crestodian agent creation did not apply: ${agentOutput}`"
      - call: runQaCli
        saveAs: discordPluginAllowOutput
        args:
          - ref: env
          - - crestodian
            - --yes
            - -m
            - config set plugins.allow ["discord"]
          - timeoutMs: 60000
            env:
              ref: crestodianEnv
      - assert:
          expr: "String(discordPluginAllowOutput).includes('[crestodian] done: config.set')"
          message:
            expr: "`Crestodian Discord plugin allowlist did not apply: ${discordPluginAllowOutput}`"
      - call: runQaCli
        saveAs: discordPluginEntryOutput
        args:
          - ref: env
          - - crestodian
            - --yes
            - -m
            - config set plugins.entries.discord.enabled true
          - timeoutMs: 60000
            env:
              ref: crestodianEnv
      - assert:
          expr: "String(discordPluginEntryOutput).includes('[crestodian] done: config.set')"
          message:
            expr: "`Crestodian Discord plugin entry did not apply: ${discordPluginEntryOutput}`"
      - call: runQaCli
        saveAs: discordTokenOutput
        args:
          - ref: env
          - - crestodian
            - --yes
            - -m
            - expr: "`config set-ref channels.discord.token env ${config.discordEnv}`"
          - timeoutMs: 60000
            env:
              ref: crestodianEnv
      - assert:
          expr: "String(discordTokenOutput).includes('[crestodian] done: config.setRef')"
          message:
            expr: "`Crestodian Discord SecretRef did not apply: ${discordTokenOutput}`"
      - call: runQaCli
        saveAs: discordEnabledOutput
        args:
          - ref: env
          - - crestodian
            - --yes
            - -m
            - config set channels.discord.enabled true
          - timeoutMs: 60000
            env:
              ref: crestodianEnv
      - assert:
          expr: "String(discordEnabledOutput).includes('[crestodian] done: config.set')"
          message:
            expr: "`Crestodian Discord enable did not apply: ${discordEnabledOutput}`"
      - call: runQaCli
        saveAs: validationOutput
        args:
          - ref: env
          - - crestodian
            - -m
            - validate config
          - timeoutMs: 60000
            env:
              ref: crestodianEnv
      - assert:
          expr: "String(validationOutput).includes('Config valid:')"
          message:
            expr: "`Crestodian config validation did not pass: ${validationOutput}`"
      - set: writtenConfig
        value:
          expr: "JSON.parse(await fs.readFile(configPath, 'utf8'))"
      - set: agent
        value:
          expr: "writtenConfig.agents?.list?.find((candidate) => candidate.id === config.agentId)"
      - assert:
          expr: "writtenConfig.agents?.defaults?.workspace === defaultWorkspace"
          message:
            expr: "`default workspace mismatch: ${JSON.stringify(writtenConfig.agents?.defaults)}`"
      - assert:
          expr: "writtenConfig.agents?.defaults?.model?.primary === config.model"
          message:
            expr: "`default model mismatch: ${JSON.stringify(writtenConfig.agents?.defaults?.model)}`"
      - assert:
          expr: "agent?.workspace === agentWorkspace && agent?.model === config.model"
          message:
            expr: "`agent config mismatch: ${JSON.stringify(agent)}`"
      - assert:
          expr: "writtenConfig.plugins?.allow?.includes('discord') && writtenConfig.plugins?.entries?.discord?.enabled === true"
          message:
            expr: "`Discord plugin was not enabled: ${JSON.stringify(writtenConfig.plugins)}`"
      - assert:
          expr: "writtenConfig.channels?.discord?.enabled === true"
          message:
            expr: "`Discord was not enabled: ${JSON.stringify(writtenConfig.channels?.discord)}`"
      - assert:
          expr: "writtenConfig.channels?.discord?.token?.source === 'env' && writtenConfig.channels?.discord?.token?.id === config.discordEnv"
          message:
            expr: "`Discord token was not an env SecretRef: ${JSON.stringify(writtenConfig.channels?.discord?.token)}`"
      - assert:
          expr: "!JSON.stringify(writtenConfig.channels?.discord ?? {}).includes(config.discordToken)"
          message: Crestodian persisted the raw Discord token.
      - set: auditText
        value:
          expr: "await fs.readFile(path.join(stateDir, 'audit', 'crestodian.jsonl'), 'utf8')"
      - forEach:
          items:
            - crestodian.setup
            - config.setDefaultModel
            - agents.create
            - config.setRef
            - config.set
          item: operation
          actions:
            - assert:
                expr: 'auditText.includes(`"operation":"${operation}"`)'
                message:
                  expr: "`missing audit entry for ${operation}: ${auditText}`"
    detailsExpr: "`stateDir=${stateDir}\\nconfigPath=${configPath}\\nagent=${JSON.stringify(agent)}\\nDiscord SecretRef=${JSON.stringify(writtenConfig.channels?.discord?.token)}`"
```
