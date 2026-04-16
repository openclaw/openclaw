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
function mentionColors(_label: string, _mentionType?: string): { bg: string; fg: string } {
	return { bg: "rgba(120, 113, 108, 0.1)", fg: "inherit" };
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
			defaultView: { default: "" },
		};
	},

	parseHTML() {
		return [{ tag: 'span[data-chat-file-mention]' }];
	},

	renderHTML({ HTMLAttributes }) {
		const label = (HTMLAttributes.label as string) || "file";
		const mType = (HTMLAttributes.mentionType as string) || "file";
		const dView = (HTMLAttributes.defaultView as string) || "";
		const colors = mentionColors(label, mType);
		return [
			"span",
			mergeAttributes(
				{
					"data-chat-file-mention": "",
					"data-mention-type": mType,
					...(dView ? { "data-default-view": dView } : {}),
					class: "chat-file-mention",
					style: `--mention-bg: ${colors.bg}; --mention-fg: ${colors.fg};`,
					title: HTMLAttributes.path || "",
				},
				HTMLAttributes,
			),
			label,
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
