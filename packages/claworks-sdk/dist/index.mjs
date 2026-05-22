//#region src/index.ts
function definePackManifest(manifest) {
	if (!manifest.id?.trim()) throw new Error("Pack manifest requires id");
	if (!manifest.version?.trim()) throw new Error("Pack manifest requires version");
	return manifest;
}
function defineObjectType(def) {
	if (!def.name?.trim()) throw new Error("ObjectType requires name");
	if (!def.fields?.length) throw new Error("ObjectType requires at least one field");
	return {
		primaryKey: "id",
		...def
	};
}
/** 将 ObjectTypeDef 序列化为 ClaWorks YAML 字符串（fields 数组格式）。 */
function objectTypeToYaml(def) {
	const lines = [
		`name: ${def.name}`,
		def.displayName ? `displayName: ${def.displayName}` : "",
		def.description ? `description: |\n  ${def.description.replace(/\n/g, "\n  ")}` : "",
		`primaryKey: ${def.primaryKey ?? "id"}`,
		"fields:"
	].filter(Boolean);
	for (const f of def.fields) {
		lines.push(`  - name: ${f.name}`);
		lines.push(`    type: ${f.type}`);
		if (f.required) lines.push(`    required: true`);
		if (f.description) lines.push(`    description: ${f.description}`);
		if (f.foreignKey) lines.push(`    foreign_key: ${f.foreignKey}`);
	}
	return lines.join("\n") + "\n";
}
/** Convenience namespace for building steps with minimal boilerplate. */
const step = {
	notify: (id, message, channels) => ({
		kind: "notification",
		id,
		message,
		channels
	}),
	llm: (id, prompt, output, opts) => ({
		kind: "llm",
		id,
		prompt,
		output,
		...opts
	}),
	action: (id, actionApiName, params, opts) => ({
		kind: "action",
		id,
		actionApiName,
		params,
		output: opts?.output ?? id
	}),
	fn: (id, functionApiName, params, output) => ({
		kind: "function",
		id,
		functionApiName,
		params,
		output
	}),
	memRead: (id, subject, key, output) => ({
		kind: "memory_read",
		id,
		subject,
		key,
		output
	}),
	memWrite: (id, subject, key, value, opts) => ({
		kind: "memory_write",
		id,
		subject,
		key,
		value,
		...opts
	}),
	publish: (id, eventType, payload, opts) => ({
		kind: "publish_event",
		id,
		eventType,
		payload,
		...opts
	}),
	hitl: (id, message, options, output, opts) => ({
		kind: "hitl",
		id,
		message,
		options,
		output,
		...opts
	}),
	cond: (id, ifExpr, then, elseBranch) => ({
		kind: "condition",
		id,
		if: ifExpr,
		then,
		else: elseBranch
	}),
	connector: (id, connectorId, method, params) => ({
		kind: "connector",
		id,
		connectorId,
		method,
		params
	}),
	subPlaybook: (id, playbookId, input) => ({
		kind: "playbook",
		id,
		playbookId,
		input
	}),
	a2a: (id, target, task, opts) => ({
		kind: "a2a_delegate",
		id,
		target,
		task,
		...opts
	}),
	subagent: (id, prompt, opts) => ({
		kind: "subagent",
		id,
		prompt,
		...opts
	}),
	skill: (id, skillId, input, output) => ({
		kind: "skill",
		id,
		skillId,
		input,
		output
	})
};
function definePlaybook(draft) {
	if (!draft.id?.trim()) throw new Error("Playbook requires id");
	if (!draft.pack?.trim()) throw new Error("Playbook requires pack");
	return {
		priority: 50,
		...draft
	};
}
/** 将 PlaybookDraft 序列化为 YAML 字符串（适合写入 Pack ontology/playbooks/ 目录）。 */
function playbookToYaml(draft) {
	const lines = [
		`id: ${draft.id}`,
		`name: ${draft.name}`,
		draft.description ? `description: |\n  ${draft.description.replace(/\n/g, "\n  ")}` : "",
		`pack: ${draft.pack}`,
		`priority: ${draft.priority ?? 50}`
	].filter(Boolean);
	const t = draft.trigger;
	lines.push("trigger:");
	lines.push(`  kind: ${t.kind}`);
	if (t.kind === "event") {
		lines.push(`  pattern: ${t.pattern}`);
		if (t.condition) lines.push(`  condition: ${t.condition}`);
		if (t.filter) lines.push(`  filter:\n${Object.entries(t.filter).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`).join("\n")}`);
	}
	if (t.kind === "schedule") {
		lines.push(`  cron: "${t.cron}"`);
		if (t.timezone) lines.push(`  timezone: ${t.timezone}`);
	}
	lines.push("steps:");
	for (const s of draft.steps) lines.push(...serializeStep(s, "  "));
	return lines.join("\n") + "\n";
}
function serializeStep(s, indent) {
	const lines = [`${indent}- id: ${s.id}`, `${indent}  kind: ${s.kind}`];
	if (s.condition) lines.push(`${indent}  condition: "${s.condition}"`);
	switch (s.kind) {
		case "notification":
			lines.push(`${indent}  message: "${s.message.replace(/"/g, "\\\"")}"`);
			if (s.channels?.length) lines.push(`${indent}  channels:\n${s.channels.map((c) => `${indent}    - ${c}`).join("\n")}`);
			break;
		case "llm":
			lines.push(`${indent}  prompt: |\n${s.prompt.split("\n").map((l) => `${indent}    ${l}`).join("\n")}`);
			if (s.model) lines.push(`${indent}  model: ${s.model}`);
			lines.push(`${indent}  output: ${s.output}`);
			break;
		case "action":
			lines.push(`${indent}  actionApiName: ${s.actionApiName}`);
			lines.push(`${indent}  params:`);
			for (const [k, v] of Object.entries(s.params)) lines.push(`${indent}    ${k}: "${v}"`);
			if (s.output) lines.push(`${indent}  output: ${s.output}`);
			break;
		case "function":
			lines.push(`${indent}  functionApiName: ${s.functionApiName}`);
			lines.push(`${indent}  params:`);
			for (const [k, v] of Object.entries(s.params)) lines.push(`${indent}    ${k}: "${v}"`);
			if (s.output) lines.push(`${indent}  output: ${s.output}`);
			break;
		case "memory_read":
			lines.push(`${indent}  subject: "${s.subject}"`);
			lines.push(`${indent}  key: "${s.key}"`);
			lines.push(`${indent}  output: ${s.output}`);
			break;
		case "memory_write":
			lines.push(`${indent}  subject: "${s.subject}"`);
			lines.push(`${indent}  key: "${s.key}"`);
			lines.push(`${indent}  value: "${s.value}"`);
			if (s.category) lines.push(`${indent}  category: ${s.category}`);
			if (s.confidence !== void 0) lines.push(`${indent}  confidence: ${s.confidence}`);
			if (s.source) lines.push(`${indent}  source: "${s.source}"`);
			if (s.output) lines.push(`${indent}  output: ${s.output}`);
			break;
		case "publish_event":
			lines.push(`${indent}  eventType: ${s.eventType}`);
			if (s.source) lines.push(`${indent}  source: ${s.source}`);
			if (s.payload) {
				lines.push(`${indent}  payload:`);
				for (const [k, v] of Object.entries(s.payload)) lines.push(`${indent}    ${k}: "${v}"`);
			}
			if (s.output) lines.push(`${indent}  output: ${s.output}`);
			break;
		case "hitl":
			lines.push(`${indent}  message: "${s.message.replace(/"/g, "\\\"")}"`);
			lines.push(`${indent}  options:\n${s.options.map((o) => `${indent}    - ${o}`).join("\n")}`);
			lines.push(`${indent}  output: ${s.output}`);
			if (s.channel) lines.push(`${indent}  channel: ${s.channel}`);
			break;
		case "condition":
			lines.push(`${indent}  if: "${s.if.replace(/"/g, "\\\"")}"`);
			lines.push(`${indent}  then:`);
			for (const child of s.then) lines.push(...serializeStep(child, indent + "    "));
			if (s.else?.length) {
				lines.push(`${indent}  else:`);
				for (const child of s.else) lines.push(...serializeStep(child, indent + "    "));
			}
			break;
		case "a2a_delegate":
			lines.push(`${indent}  target: ${s.target}`);
			lines.push(`${indent}  task: "${s.task.replace(/"/g, "\\\"")}"`);
			if (s.waitResult !== void 0) lines.push(`${indent}  waitResult: ${s.waitResult}`);
			if (s.output) lines.push(`${indent}  output: ${s.output}`);
			break;
		case "subagent":
			lines.push(`${indent}  prompt: |\n${s.prompt.split("\n").map((l) => `${indent}    ${l}`).join("\n")}`);
			if (s.model) lines.push(`${indent}  model: ${s.model}`);
			if (s.output) lines.push(`${indent}  output: ${s.output}`);
			break;
		case "skill":
			lines.push(`${indent}  skillId: ${s.skillId}`);
			if (s.output) lines.push(`${indent}  output: ${s.output}`);
			break;
		case "connector":
			lines.push(`${indent}  connectorId: ${s.connectorId}`);
			lines.push(`${indent}  method: ${s.method}`);
			break;
		case "playbook":
			lines.push(`${indent}  playbookId: ${s.playbookId}`);
			break;
	}
	return lines;
}
//#endregion
export { defineObjectType, definePackManifest, definePlaybook, objectTypeToYaml, playbookToYaml, step };
