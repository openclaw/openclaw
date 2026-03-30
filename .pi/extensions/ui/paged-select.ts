import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
	Container,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
} from "@mariozechner/pi-tui";

type CustomUiContext = {
	ui: {
		custom: <T>(
			render: (
				tui: { requestRender: () => void },
				theme: {
					fg: (tone: string, text: string) => string;
					bold: (text: string) => string;
				},
				kb: unknown,
				done: () => void,
			) => {
				render: (width: number) => string;
				invalidate: () => void;
				handleInput: (data: string) => void;
			},
		) => Promise<T>;
	};
};

export async function showPagedSelectList(params: {
	ctx: CustomUiContext;
	title: string;
	items: SelectItem[];
	onSelect: (item: SelectItem) => void;
}): Promise<void> {
	await params.ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();

		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(
			new Text(theme.fg("accent", theme.bold(params.title)), 0, 0),
		);

		const visibleRows = Math.min(params.items.length, 15);
		let currentIndex = 0;

		const selectList = new SelectList(params.items, visibleRows, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => text,
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => params.onSelect(item);
		selectList.onCancel = () => done();
		selectList.onSelectionChange = (item) => {
			currentIndex = params.items.indexOf(item);
		};
		container.addChild(selectList);

		container.addChild(
			new Text(
				theme.fg("dim", " ↑↓ navigate • ←→ page • enter open • esc close"),
				0,
				0,
			),
		);
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (matchesKey(data, Key.left)) {
					currentIndex = Math.max(0, currentIndex - visibleRows);
					selectList.setSelectedIndex(currentIndex);
				} else if (matchesKey(data, Key.right)) {
					currentIndex = Math.min(
						params.items.length - 1,
						currentIndex + visibleRows,
					);
					selectList.setSelectedIndex(currentIndex);
				} else {
					selectList.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}
