// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileManagerTree, type TreeNode } from "./file-manager-tree";

vi.mock("@dnd-kit/core", async () => {
  const ReactModule = await import("react");

  return {
    DndContext: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    DragOverlay: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    useDraggable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => undefined,
      isDragging: false,
    }),
    useDroppable: () => ({
      setNodeRef: () => undefined,
      isOver: false,
    }),
    closestCenter: () => null,
    PointerSensor: class PointerSensor {},
    useSensor: () => ({}),
    useSensors: () => [],
  };
});

vi.mock("../ui/context-menu", async () => {
  const ReactModule = await import("react");

  return {
    ContextMenu: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    ContextMenuTrigger: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    ContextMenuContent: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("div", null, children),
    ContextMenuItem: ({
      children,
      onSelect,
      disabled,
    }: {
      children: React.ReactNode;
      onSelect?: () => void;
      disabled?: boolean;
    }) =>
      ReactModule.createElement(
        "button",
        {
          type: "button",
          onClick: () => onSelect?.(),
          disabled,
        },
        children,
      ),
    ContextMenuSeparator: () => ReactModule.createElement("hr"),
    ContextMenuShortcut: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("span", null, children),
  };
});

const tree: TreeNode[] = [
  {
    name: "Tasks",
    path: "Tasks",
    type: "object",
    defaultView: "table",
    children: [
      { name: ".object.yaml", path: "Tasks/.object.yaml", type: "file" },
      { name: "entries.parquet", path: "Tasks/entries.parquet", type: "file" },
    ],
  },
  {
    name: "Notes",
    path: "Notes",
    type: "folder",
    children: [
      { name: "todo.md", path: "Notes/todo.md", type: "file" },
    ],
  },
];

function renderTree(onSelect = vi.fn()) {
  render(
    <FileManagerTree
      tree={tree}
      activePath={null}
      onSelect={onSelect}
      onRefresh={vi.fn()}
    />,
  );
  return onSelect;
}

describe("FileManagerTree object expansion", () => {
  beforeEach(() => {
    try { window.localStorage.clear(); } catch { /* noop */ }
  });

  it("clicking object rows selects and expands them", async () => {
    const user = userEvent.setup();
    const onSelect = renderTree();

    await user.click(screen.getByText("Tasks"));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ path: "Tasks", type: "object" }),
    );
    expect(screen.getByText(".object.yaml")).toBeInTheDocument();
    expect(screen.getByText("entries.parquet")).toBeInTheDocument();
  });

  it("keeps folder row clicks expanding folders", async () => {
    const user = userEvent.setup();
    renderTree();

    await user.click(screen.getByText("Notes"));

    expect(screen.getByText("todo.md")).toBeInTheDocument();
  });
});
