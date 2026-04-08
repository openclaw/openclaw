"use client";

import { useEffect, useMemo, useState } from "react";
import spinners from "unicode-animations";

type SpinnerName = keyof typeof spinners;

export function UnicodeSpinner({
	name = "braille",
	children,
	className,
	style,
}: {
	name?: SpinnerName;
	children?: React.ReactNode;
	className?: string;
	style?: React.CSSProperties;
}) {
	const [frame, setFrame] = useState(0);
	const spinner = useMemo(() => spinners[name] ?? spinners.braille, [name]);
	const frameCount = spinner.frames.length;
	const currentFrame = frameCount > 0
		? spinner.frames[frame % frameCount]
		: "";

	useEffect(() => {
		setFrame(0);
		if (frameCount <= 1 || spinner.interval <= 0) {
			return;
		}
		const timer = window.setInterval(
			() => setFrame((current) => (current + 1) % frameCount),
			spinner.interval,
		);
		return () => window.clearInterval(timer);
	}, [spinner, frameCount]);

	return (
		<span className={className} style={{ fontFamily: "monospace", ...style }}>
			{currentFrame}
			{children != null && <> {children}</>}
		</span>
	);
}
