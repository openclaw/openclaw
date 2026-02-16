import { Node, mergeAttributes } from "@tiptap/core";
import { type SuggestionOptions } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";

export const chatFileMentionPluginKey = new PluginKey("chatFileMention");

export type FileMentionAttrs = {
	label: string;
	path: string;
	/** Distinguish between file, object, and entry mentions */
	mentionType?: "file" | "object" | "entry";
	/** Object name for entry mentions */
	objectName?: string;
};

/** Resolve mention pill colors from the mention type or filename extension. */
function mentionColors(label: string, mentionType?: string): { bg: string; fg: string } {
	if (mentionType === "object") {return { bg: "rgba(14,165,233,0.15)", fg: "#0ea5e9" };}
	if (mentionType === "entry") {return { bg: "rgba(34,197,94,0.15)", fg: "#22c55e" };}
	const ext = label.split(".").pop()?.toLowerCase() ?? "";
	if (
		["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tiff", "heic"].includes(ext)
	)
		{return { bg: "rgba(16,185,129,0.15)", fg: "#10b981" };}
	if (["mp4", "webm", "mov", "avi", "mkv", "flv"].includes(ext))
		{return { bg: "rgba(139,92,246,0.15)", fg: "#8b5cf6" };}
	if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(ext))
		{return { bg: "rgba(245,158,11,0.15)", fg: "#f59e0b" };}
	if (ext === "pdf") {return { bg: "rgba(239,68,68,0.15)", fg: "#ef4444" };}
	if (
		[
			"js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
			"cpp", "c", "h", "css", "html", "json", "yaml", "yml",
			"toml", "md", "sh", "bash", "sql", "swift", "kt",
		].includes(ext)
	)
		{return { bg: "rgba(59,130,246,0.15)", fg: "#3b82f6" };}
	if (
		["doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "csv"].includes(ext)
	)
		{return { bg: "rgba(107,114,128,0.15)", fg: "#6b7280" };}
	return { bg: "rgba(107,114,128,0.10)", fg: "#9ca3af" };
}

/**
 * Inline atom node for file mentions in the chat editor.
 * Renders as a non-editable pill: [@icon filename].
 * Serializes to `[file: /absolute/path]` for the chat API.
 */
export const FileMentionNode = Node.create({
	name: "chatFileMention",
	group: "inline",
	inline: true,
	atom: true,
	selectable: true,
	draggable: true,

	addAttributes() {
		return {
			label: { default: "" },
			path: { default: "" },
			mentionType: { default: "file" },
			objectName: { default: "" },
		};
	},

	parseHTML() {
		return [{ tag: 'span[data-chat-file-mention]' }];
	},

	renderHTML({ HTMLAttributes }) {
		const label = (HTMLAttributes.label as string) || "file";
		const mType = HTMLAttributes.mentionType as string | undefined;
		const colors = mentionColors(label, mType);
		return [
			"span",
			mergeAttributes(
				{
					"data-chat-file-mention": "",
					class: "chat-file-mention",
					style: `--mention-bg: ${colors.bg}; --mention-fg: ${colors.fg};`,
					title: HTMLAttributes.path || "",
				},
				HTMLAttributes,
			),
			`@${label}`,
		];
	},
});

/** Suggestion configuration for the @ trigger in the chat editor. */
export type FileMentionSuggestionOptions = Omit<
	SuggestionOptions<{ name: string; path: string; type: string }>,
	"editor"
>;

/**
 * Build the suggestion config for the file mention node.
 * The actual items fetching and rendering is handled by the chat-editor component.
 */
export function buildFileMentionSuggestion(
	overrides: Partial<FileMentionSuggestionOptions>,
): Partial<FileMentionSuggestionOptions> {
	return {
		char: "@",
		pluginKey: chatFileMentionPluginKey,
		startOfLine: false,
		allowSpaces: true,
		...overrides,
	};
}
