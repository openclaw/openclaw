"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useLayoutEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import { Extension } from "@tiptap/core";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { createPortal } from "react-dom";
import type { Editor, Range } from "@tiptap/core";

// Unique plugin keys so both suggestions can coexist
const slashCommandPluginKey = new PluginKey("slashCommand");
const fileMentionPluginKey = new PluginKey("fileMention");

// --- Types ---

export type TreeNode = {
  name: string;
  path: string;
  type: "object" | "document" | "folder" | "file" | "database" | "report";
  icon?: string;
  children?: TreeNode[];
};

type SlashItem = {
  title: string;
  description?: string;
  icon: React.ReactNode;
  category: "file" | "block";
  command: (props: { editor: Editor; range: Range }) => void;
};

// --- Helpers ---

function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type !== "folder") {
      result.push(node);
    }
    if (node.children) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
}

function nodeTypeIcon(type: string) {
  switch (type) {
    case "document":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        </svg>
      );
    case "object":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v18" /><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" />
        </svg>
      );
    case "report":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" x2="12" y1="20" y2="10" />
          <line x1="18" x2="18" y1="20" y2="4" />
          <line x1="6" x2="6" y1="20" y2="14" />
        </svg>
      );
    default:
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        </svg>
      );
  }
}

// --- Block command icons ---

const headingIcon = (level: number) => (
  <span className="slash-cmd-icon-text">H{level}</span>
);

const bulletListIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="8" x2="21" y1="6" y2="6" /><line x1="8" x2="21" y1="12" y2="12" /><line x1="8" x2="21" y1="18" y2="18" />
    <line x1="3" x2="3.01" y1="6" y2="6" /><line x1="3" x2="3.01" y1="12" y2="12" /><line x1="3" x2="3.01" y1="18" y2="18" />
  </svg>
);

const orderedListIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="10" x2="21" y1="6" y2="6" /><line x1="10" x2="21" y1="12" y2="12" /><line x1="10" x2="21" y1="18" y2="18" />
    <path d="M4 6h1v4" /><path d="M4 10h2" /><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
  </svg>
);

const blockquoteIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z" />
    <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3z" />
  </svg>
);

const codeBlockIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
  </svg>
);

const horizontalRuleIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="2" x2="22" y1="12" y2="12" />
  </svg>
);

const imageIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </svg>
);

const tableIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v18" /><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" />
  </svg>
);

const taskListIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="6" height="6" rx="1" /><path d="m3 17 2 2 4-4" /><line x1="13" x2="21" y1="6" y2="6" /><line x1="13" x2="21" y1="18" y2="18" />
  </svg>
);

const reportIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" x2="12" y1="20" y2="10" />
    <line x1="18" x2="18" y1="20" y2="4" />
    <line x1="6" x2="6" y1="20" y2="14" />
  </svg>
);

// --- Build items ---

function buildBlockCommands(): SlashItem[] {
  return [
    {
      title: "Heading 1",
      description: "Large section heading",
      icon: headingIcon(1),
      category: "block",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run();
      },
    },
    {
      title: "Heading 2",
      description: "Medium section heading",
      icon: headingIcon(2),
      category: "block",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run();
      },
    },
    {
      title: "Heading 3",
      description: "Small section heading",
      icon: headingIcon(3),
      category: "block",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run();
      },
    },
    {
      title: "Bullet List",
      description: "Unordered list",
      icon: bulletListIcon,
      category: "block",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleBulletList().run();
      },
    },
    {
      title: "Numbered List",
      description: "Ordered list",
      icon: orderedListIcon,
      category: "block",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleOrderedList().run();
      },
    },
    {
      title: "Task List",
      description: "Checklist with checkboxes",
      icon: taskListIcon,
      category: "block",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleTaskList().run();
      },
    },
    {
      title: "Blockquote",
      description: "Quote block",
      icon: blockquoteIcon,
      category: "block",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleBlockquote().run();
      },
    },
    {
      title: "Code Block",
      description: "Fenced code block",
      icon: codeBlockIcon,
      category: "block",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
      },
    },
    {
      title: "Horizontal Rule",
      description: "Divider line",
      icon: horizontalRuleIcon,
      category: "block",
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).setHorizontalRule().run();
      },
    },
    {
      title: "Image",
      description: "Insert image from URL",
      icon: imageIcon,
      category: "block",
      command: ({ editor, range }) => {
        const url = window.prompt("Image URL:");
        if (url) {
          editor.chain().focus().deleteRange(range).setImage({ src: url }).run();
        }
      },
    },
    {
      title: "Table",
      description: "Insert a 3x3 table",
      icon: tableIcon,
      category: "block",
      command: ({ editor, range }) => {
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run();
      },
    },
    {
      title: "Report Chart",
      description: "Interactive report-json block",
      icon: reportIcon,
      category: "block",
      command: ({ editor, range }) => {
        const template = JSON.stringify(
          {
            version: 1,
            title: "New Report",
            panels: [
              {
                id: "panel-1",
                title: "Chart",
                type: "bar",
                sql: "SELECT 1 as x, 10 as y",
                mapping: { xAxis: "x", yAxis: ["y"] },
              },
            ],
          },
          null,
          2,
        );
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertContent({
            type: "reportBlock",
            attrs: { config: template },
          })
          .run();
      },
    },
  ];
}

function buildFileItems(tree: TreeNode[]): SlashItem[] {
  const flatFiles = flattenTree(tree);
  return flatFiles.map((node) => ({
    title: node.name.replace(/\.md$/, ""),
    description: node.path,
    icon: nodeTypeIcon(node.type),
    category: "file" as const,
    command: ({ editor, range }: { editor: Editor; range: Range }) => {
      const label = node.name.replace(/\.md$/, "");
      // Insert as structured content so the link mark is applied properly
      // (raw HTML strings get escaped by the Markdown extension)
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({
          type: "text",
          text: label,
          marks: [
            {
              type: "link",
              attrs: { href: node.path, target: null },
            },
          ],
        })
        .run();
    },
  }));
}

// --- Popup Component ---

type CommandListRef = {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
};

type CommandListProps = {
  items: SlashItem[];
  command: (item: SlashItem) => void;
};

const CommandList = forwardRef<CommandListRef, CommandListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    // Scroll selected into view
    useEffect(() => {
      const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    const selectItem = useCallback(
      (index: number) => {
        const item = items[index];
        if (item) {
          command(item);
        }
      },
      [items, command],
    );

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }: { event: KeyboardEvent }) => {
        if (event.key === "ArrowUp") {
          setSelectedIndex((i) => (i + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "ArrowDown") {
          setSelectedIndex((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          selectItem(selectedIndex);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div className="slash-cmd-popup">
          <div className="slash-cmd-empty">No results</div>
        </div>
      );
    }

    return (
      <div className="slash-cmd-popup" ref={listRef}>
        {items.map((item, index) => (
          <button
            type="button"
            key={`${item.category}-${item.title}`}
            className={`slash-cmd-item ${index === selectedIndex ? "slash-cmd-item-active" : ""}`}
            onClick={() => selectItem(index)}
            onMouseEnter={() => setSelectedIndex(index)}
          >
            <span className="slash-cmd-item-icon">{item.icon}</span>
            <span className="slash-cmd-item-body">
              <span className="slash-cmd-item-title">{item.title}</span>
              {item.description && (
                <span className="slash-cmd-item-desc">{item.description}</span>
              )}
            </span>
          </button>
        ))}
      </div>
    );
  },
);

CommandList.displayName = "CommandList";

// --- Floating wrapper that renders into a portal ---

function SlashPopupRenderer({
  items,
  command,
  clientRect,
  componentRef,
}: {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  clientRect: (() => DOMRect | null) | null;
  componentRef: React.RefObject<CommandListRef | null>;
}) {
  const popupRef = useRef<HTMLDivElement>(null);

  // Position popup near the cursor
  useLayoutEffect(() => {
    if (!popupRef.current || !clientRect) {return;}
    const rect = clientRect();
    if (!rect) {return;}
    const el = popupRef.current;
    el.style.position = "fixed";
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.bottom + 4}px`;
    el.style.zIndex = "50";
  }, [clientRect, items]);

  return createPortal(
    <div ref={popupRef}>
      <CommandList ref={componentRef} items={items} command={command} />
    </div>,
    document.body,
  );
}

// --- Shared suggestion render factory ---

function createSuggestionRenderer() {
  return () => {
    let container: HTMLDivElement | null = null;
    let root: ReturnType<typeof import("react-dom/client").createRoot> | null = null;
    const componentRef: React.RefObject<CommandListRef | null> = { current: null };

    return {
      onStart: (props: {
        items: SlashItem[];
        command: (item: SlashItem) => void;
        clientRect: (() => DOMRect | null) | null;
      }) => {
        container = document.createElement("div");
        document.body.appendChild(container);

        import("react-dom/client").then(({ createRoot }) => {
          root = createRoot(container!);
          root.render(
            <SlashPopupRenderer
              items={props.items}
              command={props.command}
              clientRect={props.clientRect}
              componentRef={componentRef}
            />,
          );
        });
      },
      onUpdate: (props: {
        items: SlashItem[];
        command: (item: SlashItem) => void;
        clientRect: (() => DOMRect | null) | null;
      }) => {
        root?.render(
          <SlashPopupRenderer
            items={props.items}
            command={props.command}
            clientRect={props.clientRect}
            componentRef={componentRef}
          />,
        );
      },
      onKeyDown: (props: { event: KeyboardEvent }) => {
        if (props.event.key === "Escape") {
          root?.unmount();
          container?.remove();
          container = null;
          root = null;
          return true;
        }
        return componentRef.current?.onKeyDown(props) ?? false;
      },
      onExit: () => {
        root?.unmount();
        container?.remove();
        container = null;
        root = null;
      },
    };
  };
}

// --- Extension factories ---

/**
 * "/" slash command -- markdown block commands only (headings, lists, code, etc.)
 */
export function createSlashCommand() {
  const blockCommands = buildBlockCommands();

  return Extension.create({
    name: "slashCommand",

    addOptions() {
      return {
        suggestion: {
          char: "/",
          pluginKey: slashCommandPluginKey,
          startOfLine: false,
          command: ({ editor, range, props: item }: { editor: Editor; range: Range; props: SlashItem }) => {
            item.command({ editor, range });
          },
          items: ({ query }: { query: string }) => {
            const q = query.toLowerCase();
            if (!q) {return blockCommands;}
            return blockCommands.filter(
              (item) =>
                item.title.toLowerCase().includes(q) ||
                (item.description?.toLowerCase().includes(q) ?? false),
            );
          },
          render: createSuggestionRenderer(),
        } satisfies Partial<SuggestionOptions<SlashItem>>,
      };
    },

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          ...this.options.suggestion,
        }),
      ];
    },
  });
}

/**
 * "@" mention command -- workspace file cross-linking
 */
export function createFileMention(tree: TreeNode[]) {
  const fileItems = buildFileItems(tree);

  return Extension.create({
    name: "fileMention",

    addOptions() {
      return {
        suggestion: {
          char: "@",
          pluginKey: fileMentionPluginKey,
          startOfLine: false,
          command: ({ editor, range, props: item }: { editor: Editor; range: Range; props: SlashItem }) => {
            item.command({ editor, range });
          },
          items: ({ query }: { query: string }) => {
            const q = query.toLowerCase();
            if (!q) {return fileItems.slice(0, 15);}
            return fileItems
              .filter(
                (item) =>
                  item.title.toLowerCase().includes(q) ||
                  (item.description?.toLowerCase().includes(q) ?? false),
              )
              .slice(0, 15);
          },
          render: createSuggestionRenderer(),
        } satisfies Partial<SuggestionOptions<SlashItem>>,
      };
    },

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          ...this.options.suggestion,
        }),
      ];
    },
  });
}
