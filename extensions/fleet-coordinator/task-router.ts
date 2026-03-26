/** Task routing algorithm — VRAM-aware, load-aware, schedule-aware. */

import type { FleetConfig, RoutingRecommendation } from "./types.js";
import { getActiveNodes, isNodePreferred, loadFleetConfig } from "./fleet-registry.js";
import { getNodeHealth } from "./health-monitor.js";

export function getRecommendation(
	taskType: string,
	config: FleetConfig,
	explicitNode?: string,
): RoutingRecommendation {
	// 1. Explicit node override
	if (explicitNode) {
		const node = config.nodes[explicitNode];
		if (node && node.active !== false) {
			return { node: explicitNode, confidence: "preferred", reason: `Explicitly requested: ${explicitNode}`, waitSeconds: null };
		}
		return { node: "cloud", confidence: "last_resort", reason: `Requested node ${explicitNode} not available`, waitSeconds: null };
	}

	const route = config.routing[taskType];
	if (!route) {
		return { node: "cloud", confidence: "last_resort", reason: `No routing rule for task type: ${taskType}`, waitSeconds: null };
	}

	const candidates = [route.primary, ...(route.fallback || [])];
	const activeNodes = getActiveNodes(config);

	// Score candidates
	const scored: Array<{ name: string; score: number; reason: string }> = [];

	for (const candidateName of candidates) {
		const node = activeNodes[candidateName];
		if (!node) continue;

		let score = 100;
		const reasons: string[] = [];

		// Health check
		const health = getNodeHealth(candidateName);
		if (health && !health.reachable) {
			score -= 80;
			reasons.push("unreachable");
		}

		// Schedule preference
		if (!isNodePreferred(node)) {
			score -= 30;
			reasons.push("outside preferred hours");
		}

		// Primary vs fallback bonus
		if (candidateName === route.primary) {
			score += 20;
			reasons.push("primary route");
		} else {
			reasons.push("fallback route");
		}

		scored.push({
			name: candidateName,
			score,
			reason: reasons.join(", "),
		});
	}

	// Sort by score descending
	scored.sort((a, b) => b.score - a.score);

	if (scored.length === 0) {
		return { node: "cloud", confidence: "last_resort", reason: "No candidates available", waitSeconds: null };
	}

	const best = scored[0];

	let confidence: RoutingRecommendation["confidence"] = "preferred";
	if (best.name !== route.primary) confidence = "fallback";
	if (best.score < 30) confidence = "last_resort";

	// Check if deferral makes sense
	const allBusy = scored.every((s) => s.score < 50);
	const waitSeconds = allBusy ? 30 : null;

	return {
		node: best.name,
		confidence,
		reason: best.reason,
		waitSeconds,
	};
}
