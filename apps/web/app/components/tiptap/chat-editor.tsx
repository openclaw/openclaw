"use client";

import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useRef,
} from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Suggestion from "@tiptap/suggestion";
import { Extension } from "@tiptap/core";
import { FileMentionNode, chatFileMentionPluginKey } from "./file-mention-extension";
import {
	createFileMentionRenderer,
	type SuggestItem,
} from "./file-mention-list";

// ── Types ──

export type ChatEditorHandle = {
	/** Insert a file mention node programmatically. */
	insertFileMention: (name: string, path: string) => void;
	/** Clear the editor content. */
	clear: () => void;
	/** Focus the editor. */
	focus: () => void;
	/** Check if the editor is empty (no text, no mentions). */
	isEmpty: () => boolean;
	/** Programmatically submit the current content. */
	submit: () => void;
};

type ChatEditorProps = {
	/** Called when user presses Enter (without Shift). */
	onSubmit: (text: string, mentionedFiles: Array<{ name: string; path: string }>) => void;
	/** Called on every content change. */
	onChange?: (isEmpty: boolean) => void;
	placeholder?: string;
	disabled?: boolean;
	compact?: boolean;
};

// ── Helpers ──

function getFileCategory(name: string): string {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	if (
		["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tiff", "heic"].includes(ext)
	)
		{return "image";}
	if (["mp4", "webm", "mov", "avi", "mkv", "flv"].includes(ext)) {return "video";}
	if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(ext)) {return "audio";}
	if (ext === "pdf") {return "pdf";}
	if (
		[
			"js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
			"cpp", "c", "h", "css", "html", "json", "yaml", "yml",
			"toml", "md", "sh", "bash", "sql", "swift", "kt",
		].includes(ext)
	)
		{return "code";}
	if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "csv"].includes(ext))
		{return "document";}
	return "other";
}

const categoryColors: Record<string, { bg: string; fg: string }> = {
	image: { bg: "rgba(16, 185, 129, 0.15)", fg: "#10b981" },
	video: { bg: "rgba(139, 92, 246, 0.15)", fg: "#8b5cf6" },
	audio: { bg: "rgba(245, 158, 11, 0.15)", fg: "#f59e0b" },
	pdf: { bg: "rgba(239, 68, 68, 0.15)", fg: "#ef4444" },
	code: { bg: "rgba(59, 130, 246, 0.15)", fg: "#3b82f6" },
	document: { bg: "rgba(107, 114, 128, 0.15)", fg: "#6b7280" },
	folder: { bg: "rgba(245, 158, 11, 0.15)", fg: "#f59e0b" },
	other: { bg: "rgba(107, 114, 128, 0.10)", fg: "#9ca3af" },
};

function shortenPath(path: string): string {
	return path
		.replace(/^\/Users\/[^/]+/, "~")
		.replace(/^\/home\/[^/]+/, "~")
		.replace(/^[A-Z]:\\Users\\[^\\]+/, "~");
}

/**
 * Serialize the editor content to plain text with mention markers.
 * Returns { text, mentionedFiles }.
 * Objects serialize as `[object: name]`, entries as `[entry: objectName/label]`,
 * and files as `[file: path]`.
 */
function serializeContent(editor: ReturnType<typeof useEditor>): {
	text: string;
	mentionedFiles: Array<{ name: string; path: string }>;
} {
	if (!editor) {return { text: "", mentionedFiles: [] };}

	const mentionedFiles: Array<{ name: string; path: string }> = [];
	const parts: string[] = [];

	editor.state.doc.descendants((node) => {
		if (node.type.name === "chatFileMention") {
			const label = node.attrs.label as string;
			const path = node.attrs.path as string;
			const mType = node.attrs.mentionType as string;
			const objectName = node.attrs.objectName as string;

			mentionedFiles.push({ name: label, path });

			if (mType === "object") {
				parts.push(`[object: ${label}]`);
			} else if (mType === "entry") {
				parts.push(`[entry: ${objectName ? `${objectName}/` : ""}${label}]`);
			} else {
				parts.push(`[file: ${path}]`);
			}
			return false;
		}
		if (node.isText && node.text) {
			parts.push(node.text);
		}
		if (node.type.name === "paragraph" && parts.length > 0) {
			const lastPart = parts[parts.length - 1];
			if (lastPart !== undefined && lastPart !== "\n") {
				parts.push("\n");
			}
		}
		return true;
	});

	return { text: parts.join("").trim(), mentionedFiles };
}

// ── File mention suggestion extension (wired to the async popup) ──

function createChatFileMentionSuggestion() {
	return Extension.create({
		name: "chatFileMentionSuggestion",

		addProseMirrorPlugins() {
			return [
				Suggestion({
					editor: this.editor,
					char: "@",
					pluginKey: chatFileMentionPluginKey,
					startOfLine: false,
					allowSpaces: true,
					command: ({
						editor,
						range,
						props,
					}: {
						editor: Editor;
						range: { from: number; to: number };
						props: SuggestItem;
					}) => {
						// For folders: update the query text to navigate into the folder
						if (props.type === "folder") {
							const shortPath = shortenPath(props.path);
							editor
								.chain()
								.focus()
								.deleteRange(range)
								.insertContent(`@${shortPath}/`)
								.run();
							return;
						}

						// Determine mention type for objects/entries
						const mentionType =
							props.type === "object" ? "object"
								: props.type === "entry" ? "entry"
									: "file";

						editor
							.chain()
							.focus()
							.deleteRange(range)
							.insertContent([
								{
									type: "chatFileMention",
									attrs: {
										label: props.name,
										path: props.path,
										mentionType,
										objectName: props.objectName ?? "",
									},
								},
								{ type: "text", text: " " },
							])
							.run();
					},
					items: ({ query }: { query: string }) => {
						// Items are fetched async by the renderer, return empty here
						void query;
						return [];
					},
					render: createFileMentionRenderer(),
				}),
			];
		},
	});
}

// ── Main component ──

export const ChatEditor = forwardRef<ChatEditorHandle, ChatEditorProps>(
	function ChatEditor({ onSubmit, onChange, placeholder, disabled, compact }, ref) {
		const submitRef = useRef(onSubmit);
		submitRef.current = onSubmit;

		// Ref to access the TipTap editor from within ProseMirror's handleDOMEvents
		// (the handlers are defined at useEditor() call time, before the editor exists).
		const editorRefInternal = useRef<Editor | null>(null);

		const editor = useEditor({
			immediatelyRender: false,
			extensions: [
				StarterKit.configure({
					heading: false,
					codeBlock: false,
					blockquote: false,
					horizontalRule: false,
					bulletList: false,
					orderedList: false,
					listItem: false,
				}),
				Placeholder.configure({
					placeholder: placeholder ?? "Ask anything...",
					showOnlyWhenEditable: false,
				}),
				FileMentionNode,
				createChatFileMentionSuggestion(),
			],
			editorProps: {
				attributes: {
					class: `chat-editor-content ${compact ? "chat-editor-compact" : ""}`,
					style: `color: var(--color-text);`,
				},
				handleKeyDown: (_view, event) => {
					// Enter without shift = submit
					if (event.key === "Enter" && !event.shiftKey) {
						// Don't submit if suggestion popup is active
						// The suggestion plugin handles Enter in that case
						return false;
					}
					return false;
				},
				// Handle drag-and-drop of files from the sidebar.
				// Using handleDOMEvents ensures our handler runs BEFORE
				// ProseMirror's built-in drop processing, which would
				// otherwise consume the event or insert the text/plain
				// fallback data as raw text.
				handleDOMEvents: {
					dragover: (_view, event) => {
						const de = event;
						if (de.dataTransfer?.types.includes("application/x-file-mention")) {
							de.preventDefault();
							de.dataTransfer.dropEffect = "copy";
							return true;
						}
						return false;
					},
					drop: (_view, event) => {
						const de = event;
						const data = de.dataTransfer?.getData("application/x-file-mention");
						if (!data) {return false;}

						de.preventDefault();
						de.stopPropagation();

						try {
							const { name, path } = JSON.parse(data) as { name: string; path: string };
							if (name && path) {
								editorRefInternal.current
									?.chain()
									.focus()
									.insertContent([
										{
											type: "chatFileMention",
											attrs: { label: name, path },
										},
										{ type: "text", text: " " },
									])
									.run();
							}
						} catch {
							// ignore malformed data
						}
						return true;
					},
				},
			},
			onUpdate: ({ editor: ed }) => {
				onChange?.(ed.isEmpty);
			},
		});

		// Keep internal ref in sync so handleDOMEvents handlers can access the editor
		useEffect(() => {
			editorRefInternal.current = editor ?? null;
		}, [editor]);

		// Handle Enter-to-submit via a keydown listener on the editor DOM
		useEffect(() => {
			if (!editor) {return;}

			const handleKeyDown = (event: KeyboardEvent) => {
				if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
					// Check if suggestion popup is active by checking if the plugin has active state
					const suggestState = chatFileMentionPluginKey.getState(editor.state);
					if (suggestState?.active) {return;} // Let suggestion handle it

					event.preventDefault();
					const { text, mentionedFiles } = serializeContent(editor);
					if (text.trim() || mentionedFiles.length > 0) {
						submitRef.current(text, mentionedFiles);
						editor.commands.clearContent(true);
					}
				}
			};

			const el = editor.view.dom;
			el.addEventListener("keydown", handleKeyDown);
			return () => el.removeEventListener("keydown", handleKeyDown);
		}, [editor]);

		// Disable/enable editor
		useEffect(() => {
			if (editor) {
				editor.setEditable(!disabled);
			}
		}, [editor, disabled]);

		useImperativeHandle(ref, () => ({
			insertFileMention: (name: string, path: string) => {
				editor
					?.chain()
					.focus()
					.insertContent([
						{
							type: "chatFileMention",
							attrs: { label: name, path },
						},
						{ type: "text", text: " " },
					])
					.run();
			},
			clear: () => {
				editor?.commands.clearContent(true);
			},
			focus: () => {
				editor?.commands.focus();
			},
			isEmpty: () => {
				return editor?.isEmpty ?? true;
			},
			submit: () => {
				if (!editor) {return;}
				const { text, mentionedFiles } = serializeContent(editor);
				if (text.trim() || mentionedFiles.length > 0) {
					submitRef.current(text, mentionedFiles);
					editor.commands.clearContent(true);
				}
			},
		}));

		return (
			<>
				<EditorContent editor={editor} />
				<style>{`
					.chat-editor-content {
						outline: none;
						min-height: 20px;
						max-height: 200px;
						overflow-y: auto;
						padding: ${compact ? "10px 12px" : "14px 16px"};
						font-size: ${compact ? "12px" : "14px"};
						line-height: 1.5;
						transition: opacity 0.15s ease;
					}
					.chat-editor-content[contenteditable="false"] {
						opacity: 0.5;
						cursor: not-allowed;
					}
					.chat-editor-content p {
						margin: 0;
					}
					.chat-editor-content p.is-editor-empty:first-child::before {
						content: attr(data-placeholder);
						color: var(--color-text-muted);
						float: left;
						height: 0;
						pointer-events: none;
					}
					/* File mention pill styles */
					.chat-editor-content span[data-chat-file-mention] {
						display: inline-flex;
						align-items: center;
						gap: 4px;
						padding: 1px 8px 1px 6px;
						margin: 0 1px;
						border-radius: 6px;
						background: var(--mention-bg, rgba(59, 130, 246, 0.12));
						color: var(--mention-fg, #3b82f6);
						font-size: 12px;
						font-weight: 500;
						line-height: 1.6;
						vertical-align: baseline;
						cursor: default;
						user-select: all;
						white-space: nowrap;
						transition: opacity 0.15s ease;
					}
					.chat-editor-content span[data-chat-file-mention]::before {
						content: "@";
						opacity: 0.5;
						font-size: 11px;
					}
					.chat-editor-content span[data-chat-file-mention]:hover {
						opacity: 0.85;
					}
					.chat-editor-content.chat-editor-compact {
						min-height: 16px;
					}
				`}</style>
			</>
		);
	},
);

/**
 * Helper to extract file mention info for styling (used by renderHTML).
 * Returns CSS custom properties for the mention pill.
 */
export function getMentionStyle(label: string): React.CSSProperties {
	const category = getFileCategory(label);
	const colors = categoryColors[category] ?? categoryColors.other;
	return {
		"--mention-bg": colors.bg,
		"--mention-fg": colors.fg,
	} as React.CSSProperties;
}
