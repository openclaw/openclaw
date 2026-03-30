#!/usr/bin/env tsx
/**
 * Copy export-html templates from src to dist
 */

import fs from "node:fs";
import path from "node:path";
import {
	ensureDirectory,
	logVerboseCopy,
	resolveBuildCopyContext,
} from "./lib/copy-assets.ts";

const context = resolveBuildCopyContext(import.meta.url);

const srcDir = path.join(
	context.projectRoot,
	"src",
	"auto-reply",
	"reply",
	"export-html",
);
const distDir = path.join(context.projectRoot, "dist", "export-html");

function copyExportHtmlTemplates() {
	if (!fs.existsSync(srcDir)) {
		console.warn(`${context.prefix} Source directory not found:`, srcDir);
		return;
	}

	ensureDirectory(distDir);

	const templateFiles = ["template.html", "template.css", "template.js"];
	let copiedCount = 0;
	for (const file of templateFiles) {
		const srcFile = path.join(srcDir, file);
		const distFile = path.join(distDir, file);
		if (fs.existsSync(srcFile)) {
			fs.copyFileSync(srcFile, distFile);
			copiedCount += 1;
			logVerboseCopy(context, `Copied ${file}`);
		}
	}

	const srcVendor = path.join(srcDir, "vendor");
	const distVendor = path.join(distDir, "vendor");
	if (fs.existsSync(srcVendor)) {
		ensureDirectory(distVendor);
		const vendorFiles = fs.readdirSync(srcVendor);
		for (const file of vendorFiles) {
			const srcFile = path.join(srcVendor, file);
			const distFile = path.join(distVendor, file);
			if (fs.statSync(srcFile).isFile()) {
				fs.copyFileSync(srcFile, distFile);
				copiedCount += 1;
				logVerboseCopy(context, `Copied vendor/${file}`);
			}
		}
	}

	console.log(`${context.prefix} Copied ${copiedCount} export-html assets.`);
}

copyExportHtmlTemplates();
