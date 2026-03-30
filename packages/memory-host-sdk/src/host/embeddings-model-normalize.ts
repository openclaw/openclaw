export function normalizeEmbeddingModelWithPrefixes(params: {
	model: string;
	defaultModel: string;
	prefixes: string[];
}): string {
	const trimmed = params.model.trim();
	if (!trimmed) {
		return params.defaultModel;
	}
	for (const prefix of params.prefixes) {
		if (trimmed.startsWith(prefix)) {
			return trimmed.slice(prefix.length);
		}
	}
	return trimmed;
}
