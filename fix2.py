with open('src/infra/heartbeat-runner.ts', 'r') as f:
    content = f.read()

# Fix 1: Add heartbeatFileContent param to resolveHeartbeatRunPrompt
old_sig = """function resolveHeartbeatRunPrompt(params: {
  cfg: OpenClawConfig;
  heartbeat?: HeartbeatConfig;
  preflight: HeartbeatPreflight;
  canRelayToUser: boolean;
  workspaceDir: string;
  startedAt: number;
}): HeartbeatPromptResolution {"""

new_sig = """function resolveHeartbeatRunPrompt(params: {
  cfg: OpenClawConfig;
  heartbeat?: HeartbeatConfig;
  preflight: HeartbeatPreflight;
  canRelayToUser: boolean;
  workspaceDir: string;
  startedAt: number;
  heartbeatFileContent?: string;
}): HeartbeatPromptResolution {"""

content = content.replace(old_sig, new_sig)

# Fix 2: Update the task-mode prompt to include HEARTBEAT.md directives
old_prompt = '''    if (dueTasks.length > 0) {
      const taskList = dueTasks.map((task) => `- ${task.name}: ${task.prompt}`).join("\\n");
      const prompt = `Run the following periodic tasks (only those due based on their intervals):

${taskList}

After completing all due tasks, reply HEARTBEAT_OK.`;
      return { prompt, hasExecCompletion: false, hasCronEvents: false };
    }'''

new_prompt = '''    if (dueTasks.length > 0) {
      const taskList = dueTasks.map((task) => `- ${task.name}: ${task.prompt}`).join("\\n");
      let prompt = `Run the following periodic tasks (only those due based on their intervals):

${taskList}

After completing all due tasks, reply HEARTBEAT_OK.`;

      // Preserve HEARTBEAT.md directives (non-task content)
      if (params.heartbeatFileContent) {
        const directives = params.heartbeatFileContent
          .replace(/^tasks:\\n(?:[ \\t].*\\n)*/m, "")
          .trim();
        if (directives) {
          prompt += `\\n\\nAdditional context from HEARTBEAT.md:\\n${directives}`;
        }
      }
      return { prompt, hasExecCompletion: false, hasCronEvents: false };
    }'''

content = content.replace(old_prompt, new_prompt)

# Fix 3: Pass heartbeatFileContent from call site
old_call = """  const { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({
    cfg,
    heartbeat,
    preflight,
    canRelayToUser,
    workspaceDir,
    startedAt,
  });"""

new_call = """  const { prompt, hasExecCompletion, hasCronEvents } = resolveHeartbeatRunPrompt({
    cfg,
    heartbeat,
    preflight,
    canRelayToUser,
    workspaceDir,
    startedAt,
    heartbeatFileContent: preflight.heartbeatFileContent,
  });"""

content = content.replace(old_call, new_call)

with open('src/infra/heartbeat-runner.ts', 'w') as f:
    f.write(content)

print("Fix #2 applied: HEARTBEAT.md directives preserved in task-mode prompt")
