import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "../../api.js";

function resolveGithubToken(api: OpenClawPluginApi): string | undefined {
	const pluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
	return (pluginConfig?.githubToken as string) || process.env.GITHUB_TOKEN;
}

async function githubApiFetch(
	path: string,
	token: string | undefined,
	method = "GET",
	body?: unknown,
): Promise<unknown> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	const resp = await fetch(`https://api.github.com${path}`, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});

	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new Error(`GitHub API ${resp.status}: ${text.slice(0, 500)}`);
	}
	return resp.json();
}

export function createGithubSearchTool(api: OpenClawPluginApi): AnyAgentTool {
	return {
		name: "github_search",
		description:
			"Search GitHub repositories, code, issues, or users. Returns top results with metadata.",
		input: Type.Object({
			query: Type.String({ description: "GitHub search query" }),
			type: Type.Optional(
				Type.String({
					description: 'Search type: "repositories", "code", "issues", or "users" (default: repositories)',
				}),
			),
			per_page: Type.Optional(
				Type.Number({ description: "Results per page (default: 10, max: 30)" }),
			),
		}),
		execute: async (args) => {
			const { query, type = "repositories", per_page = 10 } = args as {
				query: string;
				type?: string;
				per_page?: number;
			};
			const token = resolveGithubToken(api);
			const limit = Math.min(per_page, 30);
			const encoded = encodeURIComponent(query);
			const data = (await githubApiFetch(
				`/search/${type}?q=${encoded}&per_page=${limit}`,
				token,
			)) as { total_count: number; items: unknown[] };

			return {
				total_count: data.total_count,
				items: data.items.slice(0, limit),
			};
		},
	};
}

export function createGithubRepoInfoTool(api: OpenClawPluginApi): AnyAgentTool {
	return {
		name: "github_repo_info",
		description:
			"Get detailed information about a GitHub repository including description, stars, forks, language, and recent activity.",
		input: Type.Object({
			owner: Type.String({ description: "Repository owner (user or org)" }),
			repo: Type.String({ description: "Repository name" }),
		}),
		execute: async (args) => {
			const { owner, repo } = args as { owner: string; repo: string };
			const token = resolveGithubToken(api);
			const data = await githubApiFetch(`/repos/${owner}/${repo}`, token);
			return data;
		},
	};
}

export function createGithubCreateRepoTool(api: OpenClawPluginApi): AnyAgentTool {
	return {
		name: "github_create_repo",
		description:
			"Create a new GitHub repository. Requires a GitHub token with repo creation permissions.",
		input: Type.Object({
			name: Type.String({ description: "Repository name" }),
			description: Type.Optional(Type.String({ description: "Repository description" })),
			private: Type.Optional(
				Type.Boolean({ description: "Whether the repository should be private (default: true)" }),
			),
			auto_init: Type.Optional(
				Type.Boolean({ description: "Initialize with README (default: true)" }),
			),
		}),
		execute: async (args) => {
			const {
				name,
				description = "",
				private: isPrivate = true,
				auto_init = true,
			} = args as {
				name: string;
				description?: string;
				private?: boolean;
				auto_init?: boolean;
			};
			const token = resolveGithubToken(api);
			if (!token) {
				return { error: "GitHub token required for repo creation. Set GITHUB_TOKEN or configure githubToken in plugin config." };
			}
			const data = await githubApiFetch("/user/repos", token, "POST", {
				name,
				description,
				private: isPrivate,
				auto_init,
			});
			return data;
		},
	};
}
