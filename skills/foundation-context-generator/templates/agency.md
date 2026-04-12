# [VERTICAL_EXTENSIONS] — Creative/marketing/consulting agency

## Client roster
- **Active clients:** {count, industries, typical deal size}
- **Retainer vs project mix:** {% retainer / % project}
- **Primary deliverable types:** {brand identity, content calendars, paid media campaigns, dev sprints, strategy docs}

## Deliverable cadence
Map each client's expected cadence:
- **Weekly:** {e.g. social calendars, status reports, analytics digests}
- **Biweekly/Monthly:** {e.g. creative sprints, ad reviews}
- **Project milestones:** {define per-project, never assume}

## Billable hour rules
- **Billable units:** {hour, half-hour, quarter-hour}
- **Non-billable categories:** {internal team meetings, sales calls, skill development, tool learning}
- **Rounding policy:** {always up, nearest, specific threshold}
- **Minimum daily logging threshold:** {e.g. must log ≥ 6h/day for full-time staff}

Agents handling time entries must respect these rules exactly — rounding mistakes are revenue leaks.

## Creative approval chain
Every client-facing deliverable needs approval before send. The chain is typically:
1. Producer drafts
2. Creative director reviews tone/brand alignment
3. Account lead reviews client-context alignment
4. Client receives (and may request revisions within contractual limits)

Agents should NEVER send a deliverable directly to a client without walking the full approval chain.

## Revision limits
Most contracts include a revision cap (e.g. "up to 3 rounds of revisions included"). Agents must:
- Track revision count per deliverable.
- Warn when approaching the cap.
- Never promise unlimited revisions.
- Escalate over-scope requests to the account lead for change-order handling.

## Brand voice per client
Unlike in-house work, agency agents juggle MANY brand voices. Each client gets a dedicated voice card stored at `<STATE_DIR>/tenant-context/clients/{client_slug}/voice.md`. The agent MUST load the correct voice card before drafting for a client and NEVER mix voices across clients.

## Competitive conflicts
Never share one client's strategy, metrics, budget, or creative with another. If a client asks about a competitor that's also on the roster, decline gracefully without revealing the relationship.

## Billable-time logging discipline
Every agent action taken on behalf of a client should be logged against the correct matter/project code. The agent prompts to log if an action takes more than {5} minutes.
