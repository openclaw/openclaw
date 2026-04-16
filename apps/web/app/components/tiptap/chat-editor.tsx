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
	/** Replace the editor content with the given text and focus at end. */
	setText: (text: string) => void;
	/** Append text to the current editor content and focus at end. */
	appendText: (text: string) => void;
};

type ChatEditorProps = {
	/** Called when user presses Enter (without Shift). */
	onSubmit: (text: string, mentionedFiles: Array<{ name: string; path: string }>, html: string) => void;
	/** Called on every content change. */
	onChange?: (isEmpty: boolean) => void;
	/** Called when native files (e.g. from Finder/Desktop) are dropped onto the editor. */
	onNativeFileDrop?: (files: FileList) => void;
	placeholder?: string;
	disabled?: boolean;
	compact?: boolean;
	/** Client-side search function for instant @ mention results. */
	searchFn?: (query: string, limit?: number) => import("@/lib/search-index").SearchIndexItem[];
};

// ── Helpers ──

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
	const lines: string[] = [];

	editor.state.doc.forEach((node) => {
		if (node.type.name === "paragraph" || node.type.name === "hardBreak") {
			let lineText = "";
			node.descendants((child) => {
				if (child.type.name === "chatFileMention") {
					const label = child.attrs.label as string;
					const path = child.attrs.path as string;
					const mType = child.attrs.mentionType as string;
					const objectName = child.attrs.objectName as string;
					mentionedFiles.push({ name: label, path });
					if (mType === "object") {
						lineText += `[object: ${label}]`;
					} else if (mType === "entry") {
						lineText += `[entry: ${objectName ? `${objectName}/` : ""}${label}]`;
					} else {
						lineText += `[file: ${path}]`;
					}
					return false;
				}
				if (child.isText && child.text) {
					lineText += child.text;
				}
				if (child.type.name === "hardBreak") {
					lineText += "\n";
				}
				return true;
			});
			lines.push(lineText);
		}
	});

	return { text: lines.join("\n").trim(), mentionedFiles };
}

// ── File mention suggestion extension (wired to the async popup) ──

function createChatFileMentionSuggestion(searchFnRef?: React.RefObject<((query: string, limit?: number) => import("@/lib/search-index").SearchIndexItem[]) | null>) {
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
						const mentionType =
							props.type === "object" ? "object"
								: props.type === "entry" ? "entry"
									: props.type === "folder" ? "folder"
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
										defaultView: props.defaultView ?? "",
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
					render: createFileMentionRenderer(searchFnRef),
				}),
			];
		},
	});
}

// ── Main component ──

export const ChatEditor = forwardRef<ChatEditorHandle, ChatEditorProps>(
	function ChatEditor({ onSubmit, onChange, onNativeFileDrop, placeholder, disabled, compact, searchFn }, ref) {
		const submitRef = useRef(onSubmit);
		submitRef.current = onSubmit;

		const nativeFileDropRef = useRef(onNativeFileDrop);
		nativeFileDropRef.current = onNativeFileDrop;

		const searchFnRef = useRef(searchFn ?? null);
		searchFnRef.current = searchFn ?? null;

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
				createChatFileMentionSuggestion(searchFnRef),
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
					paste: (_view, event) => {
						const clipboardData = event.clipboardData;
						if (!clipboardData) {return false;}

						// Collect files from clipboard (images, screenshots, etc.)
						const pastedFiles: File[] = [];
						if (clipboardData.items) {
							for (const item of Array.from(clipboardData.items)) {
								if (item.kind === "file") {
									const file = item.getAsFile();
									if (file) {pastedFiles.push(file);}
								}
							}
						}

						if (pastedFiles.length > 0) {
							event.preventDefault();
							const dt = new DataTransfer();
							for (const f of pastedFiles) {dt.items.add(f);}
							nativeFileDropRef.current?.(dt.files);
							return true;
						}

						return false;
					},
					dragover: (_view, event) => {
						const de = event;
						if (de.dataTransfer?.types.includes("application/x-file-mention")) {
							de.preventDefault();
							de.dataTransfer.dropEffect = "copy";
							return true;
						}
						// Accept native file drops (e.g. from Finder/Desktop)
						if (de.dataTransfer?.types.includes("Files")) {
							de.preventDefault();
							de.dataTransfer.dropEffect = "copy";
							return true;
						}
						return false;
					},
					drop: (_view, event) => {
						const de = event;

						const clearDragHover = () => {
							const target = de.target instanceof HTMLElement
								? de.target.closest("[data-chat-drop-target]")
								: null;
							target?.removeAttribute("data-drag-hover");
						};

						// Sidebar file mention drop
						const data = de.dataTransfer?.getData("application/x-file-mention");
						if (data) {
							de.preventDefault();
							de.stopPropagation();
							clearDragHover();
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
						}

						// Native file drop (from OS file manager)
						const files = de.dataTransfer?.files;
						if (files && files.length > 0) {
							de.preventDefault();
							de.stopPropagation();
							clearDragHover();
							nativeFileDropRef.current?.(files);
							return true;
						}

						return false;
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
					const suggestState = chatFileMentionPluginKey.getState(editor.state);
					if (suggestState?.active) {return;}

					event.preventDefault();
					const { text, mentionedFiles } = serializeContent(editor);
					if (text.trim() || mentionedFiles.length > 0) {
						const html = editor.getHTML();
						submitRef.current(text, mentionedFiles, html);
						editor.commands.clearContent(true);
						requestAnimationFrame(() => editor.commands.focus());
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
					const html = editor.getHTML();
					submitRef.current(text, mentionedFiles, html);
					editor.commands.clearContent(true);
					requestAnimationFrame(() => editor.commands.focus());
				}
			},
			setText: (text: string) => {
				editor?.commands.setContent(text);
				editor?.commands.focus("end");
			},
			appendText: (text: string) => {
				if (!editor) {return;}
				const nextText = text.trim();
				if (!nextText) {return;}
				const { text: currentText } = serializeContent(editor);
				const separator = currentText.trim().length > 0 ? " " : "";
				editor
					.chain()
					.focus("end")
					.insertContent(`${separator}${nextText}`)
					.run();
			},
		}));

		return (
			<>
				<EditorContent editor={editor} />
				<style>{`
					.chat-editor-content {
						outline: none;
						min-height: ${compact ? "16px" : "28px"};
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
					/* File mention pill styles — inherits icon from global span[data-chat-file-mention]::before */
					.chat-editor-content span[data-chat-file-mention] {
						display: inline-flex;
						align-items: center;
						gap: 4px;
						padding: 1px 8px 1px 6px;
						margin: 0 1px;
						border-radius: 6px;
						background: var(--mention-bg, rgba(120, 113, 108, 0.1));
						color: inherit;
						font-size: 12px;
						font-weight: 500;
						line-height: 1.4;
						vertical-align: middle;
						cursor: default;
						user-select: all;
						white-space: nowrap;
						transition: opacity 0.15s ease;
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

