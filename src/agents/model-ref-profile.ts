export function splitTrailingAuthProfile(raw: string): {
	model: string;
	profile?: string;
} {
	const trimmed = raw.trim();
	if (!trimmed) {
		return { model: "" };
	}

	const lastSlash = trimmed.lastIndexOf("/");
	let profileDelimiter = trimmed.indexOf("@", lastSlash + 1);
	if (profileDelimiter <= 0) {
		return { model: trimmed };
	}

	const versionSuffix = trimmed.slice(profileDelimiter + 1);
	if (/^\d{8}(?:@|$)/.test(versionSuffix)) {
		const nextDelimiter = trimmed.indexOf("@", profileDelimiter + 9);
		if (nextDelimiter < 0) {
			return { model: trimmed };
		}
		profileDelimiter = nextDelimiter;
	}

	const model = trimmed.slice(0, profileDelimiter).trim();
	const profile = trimmed.slice(profileDelimiter + 1).trim();
	if (!model || !profile) {
		return { model: trimmed };
	}

	return { model, profile };
}
