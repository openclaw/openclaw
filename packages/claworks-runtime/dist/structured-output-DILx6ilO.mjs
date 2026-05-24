//#region src/kernel/structured-output.ts
function createStructuredOutputEngine(llmComplete) {
	function validate(data, schema) {
		const errors = [];
		if (typeof data !== "object" || data === null || Array.isArray(data)) return {
			valid: false,
			errors: ["输出必须是对象"]
		};
		const obj = data;
		for (const field of schema.required ?? []) if (!(field in obj) || obj[field] === void 0 || obj[field] === null) errors.push(`缺少必填字段: ${field}`);
		for (const [key, prop] of Object.entries(schema.properties ?? {})) if (key in obj && prop.enum && prop.enum.length > 0) {
			const val = obj[key];
			if (typeof val === "string" && !prop.enum.includes(val)) errors.push(`字段 ${key} 的值 "${val}" 不在允许范围内: ${prop.enum.join(", ")}`);
		}
		return {
			valid: errors.length === 0,
			errors
		};
	}
	function buildSchemaHint(schema) {
		const example = {};
		for (const [key, prop] of Object.entries(schema.properties ?? {})) if (prop.enum && prop.enum.length > 0) example[key] = prop.enum[0];
		else if (prop.type === "number") example[key] = 0;
		else if (prop.type === "boolean") example[key] = false;
		else if (prop.type === "array") example[key] = [];
		else if (prop.type === "object") example[key] = {};
		else example[key] = "";
		return JSON.stringify(example);
	}
	function tryParseJson(text) {
		try {
			const parsed = JSON.parse(text);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
		} catch {}
		const match = text.match(/\{[\s\S]*\}/);
		if (match) try {
			const parsed = JSON.parse(match[0]);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
		} catch {}
		return null;
	}
	return {
		validate,
		async complete(prompt, schema, opts = {}) {
			const maxRetries = opts.maxRetries ?? 3;
			const fallback = opts.fallback;
			let currentPrompt = prompt;
			const systemHint = `请严格以 JSON 格式输出，不要包含任何其他文字说明。输出格式示例：${buildSchemaHint(schema)}`;
			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				try {
					const parsed = tryParseJson((await llmComplete({
						prompt: currentPrompt,
						system: systemHint
					})).text);
					if (parsed !== null) {
						const validation = validate(parsed, schema);
						if (validation.valid) return {
							data: parsed,
							retries: attempt,
							fallback: false
						};
						if (attempt < maxRetries) {
							currentPrompt = `${prompt}\n\n上次输出格式有误（${validation.errors.join("; ")}），请严格按以下JSON格式重新输出：\n${buildSchemaHint(schema)}\n` + (opts.retryPrompt ? `\n${opts.retryPrompt}` : "");
							continue;
						}
					} else if (attempt < maxRetries) {
						currentPrompt = `${prompt}\n\n上次输出格式有误，请严格按以下JSON格式重新输出：\n${buildSchemaHint(schema)}\n` + (opts.retryPrompt ? `\n${opts.retryPrompt}` : "");
						continue;
					}
				} catch {
					if (attempt >= maxRetries) break;
					currentPrompt = `${prompt}\n\n请严格按以下JSON格式重新输出：\n${buildSchemaHint(schema)}\n` + (opts.retryPrompt ? `\n${opts.retryPrompt}` : "");
					continue;
				}
				if (fallback !== void 0) return {
					data: fallback,
					retries: attempt,
					fallback: true
				};
				throw new Error(`结构化输出失败：${maxRetries + 1} 次尝试均无法解析为合法 JSON schema`);
			}
			if (fallback !== void 0) return {
				data: fallback,
				retries: maxRetries,
				fallback: true
			};
			throw new Error(`结构化输出失败：${maxRetries + 1} 次尝试均无法解析为合法 JSON schema`);
		},
		async completeWithVoting(prompt, schema, opts = {}) {
			const votes = typeof opts.votes === "number" && opts.votes > 0 ? opts.votes : 3;
			const voteField = opts.voteField ?? Object.keys(schema.properties ?? {})[0] ?? "";
			const results = [];
			const attempts = await Promise.allSettled(Array.from({ length: votes }, () => this.complete(prompt, schema, {
				maxRetries: 1,
				fallback: opts.fallback
			})));
			for (const a of attempts) if (a.status === "fulfilled") results.push(a.value);
			if (results.length === 0) {
				if (opts.fallback !== void 0) return {
					data: opts.fallback,
					retries: votes,
					fallback: true,
					vote_counts: {},
					votes_cast: 0
				};
				throw new Error(`Self-consistency 全部 ${votes} 次采样均失败`);
			}
			const voteCounts = {};
			for (const r of results) {
				const v = String(r.data[voteField] ?? "__missing__");
				voteCounts[v] = (voteCounts[v] ?? 0) + 1;
			}
			const winner = Object.entries(voteCounts).sort((a, b) => b[1] - a[1])[0][0];
			return {
				...results.find((r) => String(r.data[voteField]) === winner) ?? results[0],
				vote_counts: voteCounts,
				votes_cast: results.length
			};
		}
	};
}
//#endregion
export { createStructuredOutputEngine as t };
