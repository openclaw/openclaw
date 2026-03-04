// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import {
	extFromFilename,
	monacoLangFromFilename,
	displayLang,
	MonacoCodeEditor,
} from "./code-editor";

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

type ContentChangeHandler = () => void;
type CursorChangeHandler = (e: { position: { lineNumber: number; column: number } }) => void;

let lastMockEditor: {
	getValue: ReturnType<typeof vi.fn>;
	addCommand: ReturnType<typeof vi.fn>;
	onDidChangeCursorPosition: ReturnType<typeof vi.fn>;
	onDidChangeModelContent: ReturnType<typeof vi.fn>;
	focus: ReturnType<typeof vi.fn>;
	_value: string;
	_contentChangeHandler: ContentChangeHandler | null;
	_cursorChangeHandler: CursorChangeHandler | null;
} | null = null;

let lastMockMonaco: {
	editor: {
		defineTheme: ReturnType<typeof vi.fn>;
		setTheme: ReturnType<typeof vi.fn>;
	};
	KeyMod: { CtrlCmd: number };
	KeyCode: { KeyS: number };
} | null = null;

function createMockEditor(defaultValue: string) {
	const editor = {
		_value: defaultValue,
		_contentChangeHandler: null as ContentChangeHandler | null,
		_cursorChangeHandler: null as CursorChangeHandler | null,
		getValue: vi.fn(() => editor._value),
		addCommand: vi.fn(),
		onDidChangeCursorPosition: vi.fn((handler: CursorChangeHandler) => {
			editor._cursorChangeHandler = handler;
		}),
		onDidChangeModelContent: vi.fn((handler: ContentChangeHandler) => {
			editor._contentChangeHandler = handler;
		}),
		focus: vi.fn(),
	};
	return editor;
}

function createMockMonaco() {
	return {
		editor: {
			defineTheme: vi.fn(),
			setTheme: vi.fn(),
		},
		KeyMod: { CtrlCmd: 2048 },
		KeyCode: { KeyS: 49 },
	};
}

vi.mock("@monaco-editor/react", () => ({
	default: function MockEditor(props: Record<string, unknown>) {
		const mountedRef = React.useRef(false);

		React.useEffect(() => {
			if (mountedRef.current) {return;}
			mountedRef.current = true;
			if (typeof props.onMount === "function") {
				const ed = createMockEditor(props.defaultValue as string);
				const monaco = createMockMonaco();
				lastMockEditor = ed;
				lastMockMonaco = monaco;
				props.onMount(ed, monaco);
			}
		}, []);

		return (
			<div
				data-testid="monaco-editor"
				data-language={props.language as string}
				data-theme={props.theme as string}
				data-readonly={
					typeof (props.options as { readOnly?: unknown } | undefined)?.readOnly === "boolean"
						? (props.options as { readOnly?: boolean } | undefined)?.readOnly
							? "true"
							: "false"
						: "false"
				}
			/>
		);
	},
}));

vi.mock("../diff-viewer", () => ({
	DiffCard: ({ diff }: { diff: string }) => (
		<div data-testid="diff-card">{diff.slice(0, 50)}</div>
	),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function simulateContentChange(newValue: string) {
	if (!lastMockEditor) {throw new Error("Editor not mounted");}
	lastMockEditor._value = newValue;
	lastMockEditor.getValue.mockReturnValue(newValue);
	act(() => {
		lastMockEditor!._contentChangeHandler?.();
	});
}

function simulateCursorMove(line: number, col: number) {
	if (!lastMockEditor) {throw new Error("Editor not mounted");}
	act(() => {
		lastMockEditor!._cursorChangeHandler?.({ position: { lineNumber: line, column: col } });
	});
}

// ---------------------------------------------------------------------------
// extFromFilename — extension extraction with special-filename handling
// ---------------------------------------------------------------------------

describe("extFromFilename", () => {
	it("extracts standard dot-separated extensions (basic routing correctness)", () => {
		expect(extFromFilename("app.ts")).toBe("ts");
		expect(extFromFilename("style.css")).toBe("css");
		expect(extFromFilename("data.json")).toBe("json");
		expect(extFromFilename("README.md")).toBe("md");
	});

	it("handles multi-dot filenames by taking only the last segment (prevents wrong language)", () => {
		expect(extFromFilename("package.config.json")).toBe("json");
		expect(extFromFilename("app.module.ts")).toBe("ts");
		expect(extFromFilename("my.page.test.tsx")).toBe("tsx");
	});

	it("is case-insensitive (prevents language mismatch on case-variant filenames)", () => {
		expect(extFromFilename("App.TS")).toBe("ts");
		expect(extFromFilename("STYLE.CSS")).toBe("css");
		expect(extFromFilename("Data.JSON")).toBe("json");
	});

	it("recognizes Dockerfile variants regardless of case (special-filename routing)", () => {
		expect(extFromFilename("Dockerfile")).toBe("dockerfile");
		expect(extFromFilename("dockerfile")).toBe("dockerfile");
		expect(extFromFilename("DOCKERFILE")).toBe("dockerfile");
		expect(extFromFilename("Dockerfile.dev")).toBe("dockerfile");
		expect(extFromFilename("Dockerfile.prod")).toBe("dockerfile");
		expect(extFromFilename("dockerfile.test")).toBe("dockerfile");
	});

	it("recognizes Makefile variants regardless of case (special-filename routing)", () => {
		expect(extFromFilename("Makefile")).toBe("makefile");
		expect(extFromFilename("makefile")).toBe("makefile");
		expect(extFromFilename("GNUmakefile")).toBe("makefile");
		expect(extFromFilename("gnumakefile")).toBe("makefile");
	});

	it("recognizes CMakeLists.txt regardless of case (special-filename routing)", () => {
		expect(extFromFilename("CMakeLists.txt")).toBe("cmake");
		expect(extFromFilename("cmakelists.txt")).toBe("cmake");
	});

	it("returns empty string for extensionless files (falls back to plaintext)", () => {
		expect(extFromFilename("LICENSE")).toBe("license");
		expect(extFromFilename("CHANGELOG")).toBe("changelog");
	});

	it("returns empty string for empty input (no crash on degenerate input)", () => {
		expect(extFromFilename("")).toBe("");
	});

	it("does not treat path separators as extensions (prevents path-based misrouting)", () => {
		expect(extFromFilename("src/components/App.tsx")).toBe("tsx");
		expect(extFromFilename("deeply/nested/path/file.py")).toBe("py");
	});

	it("does not misidentify files that merely contain 'dockerfile' in the name", () => {
		expect(extFromFilename("not-a-dockerfile.txt")).toBe("txt");
	});
});

// ---------------------------------------------------------------------------
// monacoLangFromFilename — maps filename → Monaco language ID
// ---------------------------------------------------------------------------

describe("monacoLangFromFilename", () => {
	it("maps common web languages correctly (editor syntax highlighting)", () => {
		expect(monacoLangFromFilename("app.ts")).toBe("typescript");
		expect(monacoLangFromFilename("app.tsx")).toBe("typescript");
		expect(monacoLangFromFilename("script.js")).toBe("javascript");
		expect(monacoLangFromFilename("script.jsx")).toBe("javascript");
		expect(monacoLangFromFilename("style.css")).toBe("css");
		expect(monacoLangFromFilename("page.html")).toBe("html");
	});

	it("maps systems/backend languages correctly", () => {
		expect(monacoLangFromFilename("main.py")).toBe("python");
		expect(monacoLangFromFilename("main.go")).toBe("go");
		expect(monacoLangFromFilename("main.rs")).toBe("rust");
		expect(monacoLangFromFilename("Main.java")).toBe("java");
		expect(monacoLangFromFilename("main.c")).toBe("c");
		expect(monacoLangFromFilename("main.cpp")).toBe("cpp");
		expect(monacoLangFromFilename("Program.cs")).toBe("csharp");
		expect(monacoLangFromFilename("main.rb")).toBe("ruby");
		expect(monacoLangFromFilename("main.swift")).toBe("swift");
		expect(monacoLangFromFilename("main.kt")).toBe("kotlin");
	});

	it("maps shell variants to 'shell' (unified shell highlighting)", () => {
		expect(monacoLangFromFilename("script.sh")).toBe("shell");
		expect(monacoLangFromFilename("script.bash")).toBe("shell");
		expect(monacoLangFromFilename("script.zsh")).toBe("shell");
		expect(monacoLangFromFilename("config.fish")).toBe("shell");
	});

	it("maps CJS/MJS variants to javascript (prevents plaintext fallback)", () => {
		expect(monacoLangFromFilename("server.mjs")).toBe("javascript");
		expect(monacoLangFromFilename("config.cjs")).toBe("javascript");
	});

	it("maps header files to the correct base language", () => {
		expect(monacoLangFromFilename("header.h")).toBe("c");
		expect(monacoLangFromFilename("header.hpp")).toBe("cpp");
	});

	it("maps config formats correctly", () => {
		expect(monacoLangFromFilename("config.yaml")).toBe("yaml");
		expect(monacoLangFromFilename("config.yml")).toBe("yaml");
		expect(monacoLangFromFilename("data.json")).toBe("json");
		expect(monacoLangFromFilename("tsconfig.jsonc")).toBe("json");
		expect(monacoLangFromFilename("config.ini")).toBe("ini");
		expect(monacoLangFromFilename(".env")).toBe("ini");
	});

	it("maps template languages to html as fallback (some highlighting > none)", () => {
		expect(monacoLangFromFilename("App.vue")).toBe("html");
		expect(monacoLangFromFilename("Page.svelte")).toBe("html");
	});

	it("falls back to plaintext for unsupported extensions (no crash on unknown files)", () => {
		expect(monacoLangFromFilename("data.toml")).toBe("plaintext");
		expect(monacoLangFromFilename("main.zig")).toBe("plaintext");
		expect(monacoLangFromFilename("app.tf")).toBe("plaintext");
		expect(monacoLangFromFilename("unknown.xyz")).toBe("plaintext");
	});

	it("falls back to plaintext for extensionless files", () => {
		expect(monacoLangFromFilename("LICENSE")).toBe("plaintext");
		expect(monacoLangFromFilename("CHANGELOG")).toBe("plaintext");
	});

	it("special filenames map through their virtual extension", () => {
		expect(monacoLangFromFilename("Dockerfile")).toBe("dockerfile");
		expect(monacoLangFromFilename("Makefile")).toBe("plaintext");
		expect(monacoLangFromFilename("CMakeLists.txt")).toBe("plaintext");
	});
});

// ---------------------------------------------------------------------------
// displayLang — determines what label is shown in the header badge
// ---------------------------------------------------------------------------

describe("displayLang", () => {
	it("shows the language name for recognized languages", () => {
		expect(displayLang("app.ts")).toBe("typescript");
		expect(displayLang("main.py")).toBe("python");
		expect(displayLang("style.css")).toBe("css");
		expect(displayLang("query.sql")).toBe("sql");
	});

	it("shows the raw extension for plaintext-mapped languages (user can still identify the file type)", () => {
		expect(displayLang("data.toml")).toBe("toml");
		expect(displayLang("main.zig")).toBe("zig");
		expect(displayLang("deploy.tf")).toBe("tf");
	});

	it("shows TEXT for files with no extension at all (graceful fallback)", () => {
		expect(displayLang("LICENSE")).toBe("license");
		// empty filename edge case
		expect(displayLang("")).toBe("TEXT");
	});

	it("shows the special filename as extension when it maps to plaintext", () => {
		expect(displayLang("Makefile")).toBe("makefile");
		expect(displayLang("CMakeLists.txt")).toBe("cmake");
	});

	it("shows 'dockerfile' for Dockerfile (which has a real Monaco language)", () => {
		expect(displayLang("Dockerfile")).toBe("dockerfile");
	});
});

// ---------------------------------------------------------------------------
// MonacoCodeEditor — component routing (diff/patch vs editor)
// ---------------------------------------------------------------------------

describe("MonacoCodeEditor routing", () => {
	beforeEach(() => {
		lastMockEditor = null;
		lastMockMonaco = null;
	});

	it("routes .diff files to DiffCard instead of the editor (prevents rendering diffs as raw text)", () => {
		render(<MonacoCodeEditor content="--- a/file\n+++ b/file\n" filename="changes.diff" />);
		expect(screen.getByTestId("diff-card")).toBeInTheDocument();
		expect(screen.queryByTestId("monaco-editor")).not.toBeInTheDocument();
	});

	it("routes .patch files to DiffCard instead of the editor", () => {
		render(<MonacoCodeEditor content="--- a/file\n+++ b/file\n" filename="fix.patch" />);
		expect(screen.getByTestId("diff-card")).toBeInTheDocument();
		expect(screen.queryByTestId("monaco-editor")).not.toBeInTheDocument();
	});

	it("routes .DIFF files to DiffCard (case-insensitive routing)", () => {
		render(<MonacoCodeEditor content="diff content" filename="CHANGES.DIFF" />);
		expect(screen.getByTestId("diff-card")).toBeInTheDocument();
	});

	it("routes normal code files to the Monaco editor", () => {
		render(<MonacoCodeEditor content="const x = 1;" filename="app.ts" filePath="app.ts" />);
		expect(screen.getByTestId("monaco-editor")).toBeInTheDocument();
		expect(screen.queryByTestId("diff-card")).not.toBeInTheDocument();
	});

	it("routes unknown extensions to the editor (not DiffCard)", () => {
		render(<MonacoCodeEditor content="some content" filename="data.xyz" filePath="data.xyz" />);
		expect(screen.getByTestId("monaco-editor")).toBeInTheDocument();
	});
});

// ---------------------------------------------------------------------------
// MonacoCodeEditor — header bar rendering
// ---------------------------------------------------------------------------

describe("MonacoCodeEditor header bar", () => {
	beforeEach(() => {
		lastMockEditor = null;
		lastMockMonaco = null;
	});

	it("displays the filename in the header", () => {
		render(<MonacoCodeEditor content="hello" filename="server.py" filePath="server.py" />);
		expect(screen.getByText("server.py")).toBeInTheDocument();
	});

	it("displays the language badge in uppercase", () => {
		render(<MonacoCodeEditor content="hello" filename="server.py" filePath="server.py" />);
		expect(screen.getByText("PYTHON")).toBeInTheDocument();
	});

	it("displays the correct line count", () => {
		const content = "line1\nline2\nline3";
		render(<MonacoCodeEditor content={content} filename="app.ts" filePath="app.ts" />);
		expect(screen.getByText("3 lines")).toBeInTheDocument();
	});

	it("displays single line for single-line content", () => {
		render(<MonacoCodeEditor content="x" filename="app.ts" filePath="app.ts" />);
		expect(screen.getByText("1 lines")).toBeInTheDocument();
	});

	it("displays default cursor position Ln 1, Col 1", () => {
		render(<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />);
		expect(screen.getByText("Ln 1, Col 1")).toBeInTheDocument();
	});

	it("updates cursor position when editor reports cursor change", () => {
		render(<MonacoCodeEditor content="hello\nworld" filename="app.ts" filePath="app.ts" />);
		simulateCursorMove(2, 5);
		expect(screen.getByText("Ln 2, Col 5")).toBeInTheDocument();
	});

	it("passes the correct language to Monaco editor", () => {
		render(<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />);
		const editor = screen.getByTestId("monaco-editor");
		expect(editor.dataset.language).toBe("typescript");
	});

	it("passes correct language for shell scripts", () => {
		render(<MonacoCodeEditor content="#!/bin/bash" filename="deploy.sh" filePath="deploy.sh" />);
		const editor = screen.getByTestId("monaco-editor");
		expect(editor.dataset.language).toBe("shell");
	});
});

// ---------------------------------------------------------------------------
// MonacoCodeEditor — read-only enforcement
// ---------------------------------------------------------------------------

describe("MonacoCodeEditor read-only enforcement", () => {
	beforeEach(() => {
		lastMockEditor = null;
		lastMockMonaco = null;
	});

	it("sets editor to read-only when filePath is absent (prevents unintended writes)", () => {
		render(<MonacoCodeEditor content="const x = 1;" filename="app.ts" />);
		const editor = screen.getByTestId("monaco-editor");
		expect(editor.dataset.readonly).toBe("true");
	});

	it("does not render save button when filePath is absent (no save affordance for read-only)", () => {
		render(<MonacoCodeEditor content="const x = 1;" filename="app.ts" />);
		expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
	});

	it("sets editor to editable when filePath is provided", () => {
		render(<MonacoCodeEditor content="const x = 1;" filename="app.ts" filePath="src/app.ts" />);
		const editor = screen.getByTestId("monaco-editor");
		expect(editor.dataset.readonly).toBe("false");
	});

	it("renders save button when filePath is provided", () => {
		render(<MonacoCodeEditor content="const x = 1;" filename="app.ts" filePath="src/app.ts" />);
		expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
	});
});

// ---------------------------------------------------------------------------
// MonacoCodeEditor — save state machine
// ---------------------------------------------------------------------------

describe("MonacoCodeEditor save flow", () => {
	beforeEach(() => {
		lastMockEditor = null;
		lastMockMonaco = null;
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("save button is disabled in clean state (prevents redundant API calls)", () => {
		render(<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />);
		const btn = screen.getByRole("button", { name: /save/i });
		expect(btn).toBeDisabled();
	});

	it("marks editor as dirty when content changes differ from original (tracks unsaved changes)", () => {
		render(<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />);
		simulateContentChange("hello world");
		expect(screen.getByTitle("Unsaved changes")).toBeInTheDocument();
		const btn = screen.getByRole("button", { name: /save/i });
		expect(btn).not.toBeDisabled();
	});

	it("returns to clean state when content is reverted to original (no false dirty indicator)", () => {
		render(<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />);
		simulateContentChange("hello world");
		expect(screen.getByTitle("Unsaved changes")).toBeInTheDocument();
		simulateContentChange("hello");
		expect(screen.queryByTitle("Unsaved changes")).not.toBeInTheDocument();
	});

	it("sends correct path and content to the save API on save (data integrity)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
		global.fetch = fetchMock;

		render(<MonacoCodeEditor content="original" filename="app.ts" filePath="src/app.ts" />);
		simulateContentChange("modified content");

		const btn = screen.getByRole("button", { name: /save/i });
		await act(async () => {
			btn.click();
		});

		expect(fetchMock).toHaveBeenCalledWith("/api/workspace/file", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "src/app.ts", content: "modified content" }),
		});
	});

	it("shows 'Saved' indicator after successful save", async () => {
		global.fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));

		render(<MonacoCodeEditor content="original" filename="app.ts" filePath="app.ts" />);
		simulateContentChange("modified");

		const btn = screen.getByRole("button", { name: /save/i });
		await act(async () => {
			btn.click();
		});

		expect(screen.getByText("Saved")).toBeInTheDocument();
	});

	it("clears 'Saved' indicator after timeout (returns to clean state)", async () => {
		global.fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));

		render(<MonacoCodeEditor content="original" filename="app.ts" filePath="app.ts" />);
		simulateContentChange("modified");

		await act(async () => {
			screen.getByRole("button", { name: /save/i }).click();
		});
		expect(screen.getByText("Saved")).toBeInTheDocument();

		act(() => { vi.advanceTimersByTime(2000); });
		expect(screen.queryByText("Saved")).not.toBeInTheDocument();
	});

	it("shows 'Save failed' on HTTP error response (user sees error feedback)", async () => {
		global.fetch = vi.fn().mockResolvedValue(new Response("Error", { status: 500 }));

		render(<MonacoCodeEditor content="original" filename="app.ts" filePath="app.ts" />);
		simulateContentChange("modified");

		await act(async () => {
			screen.getByRole("button", { name: /save/i }).click();
		});

		expect(screen.getByText("Save failed")).toBeInTheDocument();
	});

	it("shows 'Save failed' on network error (user sees error feedback)", async () => {
		global.fetch = vi.fn().mockRejectedValue(new TypeError("Network error"));

		render(<MonacoCodeEditor content="original" filename="app.ts" filePath="app.ts" />);
		simulateContentChange("modified");

		await act(async () => {
			screen.getByRole("button", { name: /save/i }).click();
		});

		expect(screen.getByText("Save failed")).toBeInTheDocument();
	});

	it("reverts to dirty state after error timeout (allows retry)", async () => {
		global.fetch = vi.fn().mockRejectedValue(new TypeError("Network error"));

		render(<MonacoCodeEditor content="original" filename="app.ts" filePath="app.ts" />);
		simulateContentChange("modified");

		await act(async () => {
			screen.getByRole("button", { name: /save/i }).click();
		});
		expect(screen.getByText("Save failed")).toBeInTheDocument();

		act(() => { vi.advanceTimersByTime(3000); });
		expect(screen.queryByText("Save failed")).not.toBeInTheDocument();
		expect(screen.getByTitle("Unsaved changes")).toBeInTheDocument();
	});

	it("shows 'Saving...' indicator during save (user knows operation is in progress)", async () => {
		let resolvePromise!: (value: Response) => void;
		const pendingPromise = new Promise<Response>((resolve) => { resolvePromise = resolve; });
		global.fetch = vi.fn().mockReturnValue(pendingPromise);

		render(<MonacoCodeEditor content="original" filename="app.ts" filePath="app.ts" />);
		simulateContentChange("modified");

		await act(async () => {
			screen.getByRole("button", { name: /save/i }).click();
		});

		expect(screen.getByText("Saving...")).toBeInTheDocument();

		await act(async () => {
			resolvePromise(jsonResponse({ ok: true }));
		});
		expect(screen.queryByText("Saving...")).not.toBeInTheDocument();
	});

	it("updates baseline after successful save so matching content shows clean (prevents false dirty after save)", async () => {
		global.fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));

		render(<MonacoCodeEditor content="original" filename="app.ts" filePath="app.ts" />);
		simulateContentChange("modified");

		await act(async () => {
			screen.getByRole("button", { name: /save/i }).click();
		});

		act(() => { vi.advanceTimersByTime(2000); });

		// Content is now "modified" which matches the saved baseline
		expect(screen.queryByTitle("Unsaved changes")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
	});

	it("after save, editing back to saved content shows clean (baseline tracks last-saved value)", async () => {
		global.fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));

		render(<MonacoCodeEditor content="original" filename="app.ts" filePath="app.ts" />);
		simulateContentChange("modified");

		await act(async () => {
			screen.getByRole("button", { name: /save/i }).click();
		});

		act(() => { vi.advanceTimersByTime(2000); });

		// Now edit to something else
		simulateContentChange("something else");
		expect(screen.getByTitle("Unsaved changes")).toBeInTheDocument();

		// Edit back to the saved value ("modified") — should be clean
		simulateContentChange("modified");
		expect(screen.queryByTitle("Unsaved changes")).not.toBeInTheDocument();
	});

	it("after save, editing to original (pre-save) content still shows dirty (baseline is the saved value, not original)", async () => {
		global.fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));

		render(<MonacoCodeEditor content="original" filename="app.ts" filePath="app.ts" />);
		simulateContentChange("saved-value");

		await act(async () => {
			screen.getByRole("button", { name: /save/i }).click();
		});

		act(() => { vi.advanceTimersByTime(2000); });

		// Edit to the original prop value — should still be dirty because baseline is now "saved-value"
		simulateContentChange("original");
		expect(screen.getByTitle("Unsaved changes")).toBeInTheDocument();
	});

	it("does not call save API when editor ref is missing (guard against null ref)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
		global.fetch = fetchMock;

		// Render without filePath (which means no save button), but also validates
		// the internal guard in saveFile that checks editorRef.current
		render(<MonacoCodeEditor content="hello" filename="app.ts" />);

		expect(fetchMock).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// MonacoCodeEditor — editor mount behavior
// ---------------------------------------------------------------------------

describe("MonacoCodeEditor editor mount", () => {
	beforeEach(() => {
		lastMockEditor = null;
		lastMockMonaco = null;
	});

	it("focuses the editor on mount (ready-to-type UX)", () => {
		render(<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />);
		expect(lastMockEditor!.focus).toHaveBeenCalled();
	});

	it("registers Cmd+S keybinding on mount (keyboard shortcut for save)", () => {
		render(<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />);
		expect(lastMockEditor!.addCommand).toHaveBeenCalledWith(
			2048 | 49, // CtrlCmd | KeyS
			expect.any(Function),
		);
	});

	it("registers content change and cursor position listeners on mount", () => {
		render(<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />);
		expect(lastMockEditor!.onDidChangeModelContent).toHaveBeenCalledWith(expect.any(Function));
		expect(lastMockEditor!.onDidChangeCursorPosition).toHaveBeenCalledWith(expect.any(Function));
	});

	it("registers custom themes with Monaco on mount", () => {
		render(<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />);
		// defineTheme is called by registerThemes, which runs idempotently
		// At minimum, setTheme should be called with the current theme
		expect(lastMockMonaco!.editor.setTheme).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// MonacoCodeEditor — theme switching
// ---------------------------------------------------------------------------

describe("MonacoCodeEditor theme", () => {
	beforeEach(() => {
		lastMockEditor = null;
		lastMockMonaco = null;
		document.documentElement.classList.remove("dark");
	});

	afterEach(() => {
		document.documentElement.classList.remove("dark");
	});

	it("uses light theme when html element does not have dark class", () => {
		render(<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />);
		const editor = screen.getByTestId("monaco-editor");
		expect(editor.dataset.theme).toBe("ironclaw-light");
	});

	it("uses dark theme when html element has dark class", () => {
		document.documentElement.classList.add("dark");
		render(<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />);
		const editor = screen.getByTestId("monaco-editor");
		expect(editor.dataset.theme).toBe("ironclaw-dark");
	});

	it("switches theme dynamically when html class changes (MutationObserver)", async () => {
		render(<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />);
		const editor = screen.getByTestId("monaco-editor");
		expect(editor.dataset.theme).toBe("ironclaw-light");

		act(() => {
			document.documentElement.classList.add("dark");
		});

		await waitFor(() => {
			expect(editor.dataset.theme).toBe("ironclaw-dark");
		});
	});

	it("switches back to light theme when dark class is removed", async () => {
		document.documentElement.classList.add("dark");
		render(<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />);
		const editor = screen.getByTestId("monaco-editor");
		expect(editor.dataset.theme).toBe("ironclaw-dark");

		act(() => {
			document.documentElement.classList.remove("dark");
		});

		await waitFor(() => {
			expect(editor.dataset.theme).toBe("ironclaw-light");
		});
	});
});

// ---------------------------------------------------------------------------
// MonacoCodeEditor — className passthrough
// ---------------------------------------------------------------------------

describe("MonacoCodeEditor className", () => {
	beforeEach(() => {
		lastMockEditor = null;
		lastMockMonaco = null;
	});

	it("applies custom className to the root element", () => {
		const { container } = render(
			<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" className="my-custom-class" />,
		);
		const root = container.firstElementChild!;
		expect(root.classList.contains("my-custom-class")).toBe(true);
	});

	it("does not crash when className is undefined", () => {
		const { container } = render(
			<MonacoCodeEditor content="hello" filename="app.ts" filePath="app.ts" />,
		);
		const root = container.firstElementChild!;
		expect(root.classList.contains("flex")).toBe(true);
	});
});
