const MOONSHOT_THINKING_PAYLOAD_COMPAT_PROVIDERS = new Set([
	"moonshot",
	"kimi",
]);

export function usesMoonshotThinkingPayloadCompatStatic(
	provider?: string | null,
): boolean {
	return (
		provider != null && MOONSHOT_THINKING_PAYLOAD_COMPAT_PROVIDERS.has(provider)
	);
}
