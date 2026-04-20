#!/usr/bin/env -S node --import tsx
/**
 * Morning Report Data Prep
 *
 * Processes raw Coperniq + email caches into a compact summary for JR's
 * morning report. Outputs to ~/.openclaw/cache/morning-report-brief.json
 *
 * Run after the morning pre-sync and before the morning cron fires.
 *
 * Usage: `pnpm exec tsx scripts/morning-report-data.ts` (from repo root)
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE = join(homedir(), ".openclaw", "cache", "coperniq");
const EMAIL_ARCHIVE = join(process.cwd(), "email-archive", "emails.json");
const OUTPUT = join(homedir(), ".openclaw", "cache", "morning-report-brief.json");

interface WO {
  id: number;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  isCompleted: boolean;
  isArchived: boolean;
  priority: number;
  assignee?: { id: number; firstName: string; lastName: string };
  project?: { id: number; title: string; address?: string[] };
  checklist?: Array<{ detail: string; isCompleted: boolean }>;
  statuses?: Array<{ status: string; spentTime: number; startedAt: string; endedAt: string }>;
}

interface Email {
  id: string;
  threadId: string;
  date: string;
  from: string;
  subject: string;
  labels: string[];
}

const TEAM: Record<number, string> = {
  14206: "Sam",
  14204: "Clay",
  14205: "Daxton",
  14649: "Kaleb T",
  14884: "Junrey",
};

const TWO_DAYS_AGO = Date.now() - 2 * 24 * 60 * 60 * 1000;

function loadJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function daysInStatus(wo: WO): number {
  const current = (wo.statuses ?? []).find(
    (s) => s.status.toUpperCase() === wo.status?.toUpperCase(),
  );
  if (current?.spentTime) {
    return Math.round(current.spentTime / 86400);
  }
  const created = new Date(wo.createdAt).getTime();
  return Math.round((Date.now() - created) / 86400000);
}

function openChecklist(wo: WO): string[] {
  return (wo.checklist ?? []).filter((c) => !c.isCompleted).map((c) => c.detail);
}

interface Project {
  id: number;
  status: string;
  title: string;
}

function buildWOSummary(wos: WO[], activeProjectIds: Set<number>) {
  // Pre-calculate which projects have completed engineering
  const projectEngStatus = new Map<number, boolean>();
  for (const w of wos) {
    if (!w.project?.id) {
      continue;
    }
    if (w.title.toLowerCase().includes("engineering")) {
      const isComplete = w.status?.toLowerCase() === "completed";
      // If we already saw an incomplete one, don't overwrite with complete unless we want to?
      // Let's say if ANY engineering WO is NOT completed, then engineering is not completed.
      const existing = projectEngStatus.get(w.project.id);
      if (existing === undefined) {
        projectEngStatus.set(w.project.id, isComplete);
      } else {
        projectEngStatus.set(w.project.id, existing && isComplete);
      }
    }
  }

  const open = wos.filter(
    (w) => !w.isCompleted && !w.isArchived && activeProjectIds.has(w.project?.id ?? -1),
  );

  const byEmployee: Record<
    string,
    {
      statusCounts: { Assigned: number; Working: number; Waiting: number; Total: number };
      topWOs: Array<{
        id: number;
        title: string;
        project: string;
        status: string;
        daysInStatus: number;
        openChecklist: string[];
        priority: string;
      }>;
    }
  > = {};

  for (const name of Object.values(TEAM)) {
    byEmployee[name] = {
      statusCounts: { Assigned: 0, Working: 0, Waiting: 0, Total: 0 },
      topWOs: [],
    };
  }

  for (const wo of open) {
    const assigneeId = wo.assignee?.id;
    if (!assigneeId || !TEAM[assigneeId]) {
      continue;
    }

    const name = TEAM[assigneeId];
    const days = daysInStatus(wo);

    let priorityLabel: string;
    const status = wo.status?.toLowerCase() ?? "";
    const s = wo.status ?? "Unknown";
    if (status === "assigned") {
      priorityLabel = days > 5 ? "SLA" : "HIGH";
    } else if (status === "working") {
      priorityLabel = days > 5 ? "SLA" : "MED";
    } else if (status === "waiting") {
      if (days < 7) {
        continue;
      } // skip waiting < 7 days
      priorityLabel = days > 21 ? "SLA" : "LOW";
    } else {
      priorityLabel = "INFO";
    }

    const sTitle = s.toLowerCase();
    if (sTitle === "assigned") {
      byEmployee[name].statusCounts.Assigned++;
    } else if (sTitle === "working") {
      byEmployee[name].statusCounts.Working++;
    } else if (sTitle === "waiting") {
      byEmployee[name].statusCounts.Waiting++;
    }
    byEmployee[name].statusCounts.Total++;

    // Exclude Utility-dependent WOs from the actionable top list
    if (
      wo.title.toLowerCase().includes("utility") ||
      wo.title.toLowerCase().includes("nem application") ||
      wo.title.toLowerCase().includes("interconnection")
    ) {
      continue;
    }

    if (name === "Kaleb T" && wo.title.toLowerCase().includes("plan review")) {
      const engComplete = projectEngStatus.get(wo.project?.id ?? -1);
      // If engineering is explicitly not completed (exists and is false), skip it
      if (engComplete === false) {
        continue;
      }
    }

    // Junrey oversees Verofication - surface these to him even if assigned to others
    if (wo.title.toLowerCase().includes("verofication") && name !== "Junrey") {
      byEmployee["Junrey"].statusCounts.Total++;
      byEmployee["Junrey"].statusCounts[
        sTitle === "assigned" ? "Assigned" : sTitle === "working" ? "Working" : "Waiting"
      ]++;
      byEmployee["Junrey"].topWOs.push({
        id: wo.id,
        title: wo.title,
        project: wo.project?.title ?? "Unknown",
        status: wo.status,
        daysInStatus: days,
        openChecklist: openChecklist(wo),
        priority: priorityLabel,
      });
    }

    byEmployee[name].topWOs.push({
      id: wo.id,
      title: wo.title,
      project: wo.project?.title ?? "Unknown",
      status: wo.status,
      daysInStatus: days,
      openChecklist: openChecklist(wo),
      priority: priorityLabel,
    });
  }

  // Sort: HIGH first (by days desc), then MED, then LOW
  const priorityOrder: Record<string, number> = { SLA: 0, HIGH: 1, MED: 2, LOW: 3, INFO: 4 };
  for (const name of Object.keys(byEmployee)) {
    byEmployee[name].topWOs.sort((a, b) => {
      const po = (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9);
      if (po !== 0) {
        return po;
      }
      return b.daysInStatus - a.daysInStatus;
    });
    byEmployee[name].topWOs = byEmployee[name].topWOs.slice(0, 5);
  }

  // Status totals
  const statusCounts: Record<string, number> = {};
  for (const wo of open) {
    const s = wo.status ?? "Unknown";
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }

  return { byEmployee, statusCounts, totalOpen: open.length };
}

function buildEmailBrief(emails: Email[]) {
  const cutoff = new Date(TWO_DAYS_AGO);
  const recent = emails.filter((e) => {
    const d = new Date(e.date.replace(" ", "T") + ":00");
    return d >= cutoff;
  });

  const sam: Array<{ from: string; subject: string; date: string }> = [];
  const clay: Array<{ from: string; subject: string; date: string }> = [];
  const daxton: Array<{ from: string; subject: string; date: string }> = [];
  const kalebt: Array<{ from: string; subject: string; date: string }> = [];
  const junrey: Array<{ from: string; subject: string; date: string }> = [];

  for (const e of recent) {
    const fromLower = e.from.toLowerCase();
    const subjLower = (e.subject || "").toLowerCase();

    // Sam: NTP/M2/M3 stipulations, customer permitting emails
    if (
      subjLower.includes("ntp stipulation") ||
      subjLower.includes("ntp approval") ||
      subjLower.includes("m2 stipulation") ||
      subjLower.includes("m3 stipulation") ||
      subjLower.includes("m2") ||
      subjLower.includes("m3") ||
      (fromLower.includes("permitting@veropwr") && !fromLower.includes("notification@"))
    ) {
      sam.push({ from: e.from, subject: e.subject, date: e.date });
    }

    // Clay: AHJ/city/government, permit approvals/corrections
    if (
      subjLower.includes("permit") ||
      subjLower.includes("inspection") ||
      subjLower.includes("correction") ||
      fromLower.includes("city") ||
      fromLower.includes("county") ||
      fromLower.includes("gov") ||
      fromLower.includes("municipality") ||
      (fromLower.includes("permitting@veropwr") &&
        (subjLower.includes("permit") ||
          subjLower.includes("inspection") ||
          subjLower.includes("correction")))
    ) {
      clay.push({ from: e.from, subject: e.subject, date: e.date });
    }

    // Daxton: utility interconnection, PTO, meter
    if (
      subjLower.includes("interconnection") ||
      subjLower.includes("pto") ||
      subjLower.includes("meter set") ||
      subjLower.includes("utility") ||
      (fromLower.includes("permitting@veropwr") &&
        (subjLower.includes("interconnection") ||
          subjLower.includes("utility") ||
          subjLower.includes("pto")))
    ) {
      let subj = e.subject;
      if (fromLower.includes("centerpointenergy")) {
        try {
          const out = execSync(`gog gmail get ${e.id} -a jr@veropwr.com -j`, { encoding: "utf8" });
          const data = JSON.parse(out);
          const match = data.body?.match(/Customer Name:.*?<td[^>]*>.*?<span>(?:&nbsp;)?(.*?)</is);
          if (match && match[1]) {
            subj += ` (${match[1].trim()})`;
          }
        } catch {
          /* ignore enrichment failures */
        }
      }
      daxton.push({ from: e.from, subject: subj, date: e.date });
    }

    // Customer emails: NOT from internal or known automated systems
    const isCustomer =
      !fromLower.includes("@veropwr.com") &&
      !fromLower.includes("@coperniq.io") &&
      !fromLower.includes("@luxfinancial.io") &&
      !fromLower.includes("anbetrack") &&
      !fromLower.includes("powerclerk") &&
      !fromLower.includes("mygovernmentonline");

    if (isCustomer) {
      sam.push({ from: e.from, subject: "[CUSTOMER] " + e.subject, date: e.date });
      junrey.push({ from: e.from, subject: "[CUSTOMER] " + e.subject, date: e.date });
    }

    if (
      subjLower.includes("kaleb") ||
      subjLower.includes("terranova") ||
      (fromLower.includes("kaleb") && fromLower.includes("terranova"))
    ) {
      kalebt.push({ from: e.from, subject: e.subject, date: e.date });
    }
    if (subjLower.includes("junrey") || fromLower.includes("junrey")) {
      junrey.push({ from: e.from, subject: e.subject, date: e.date });
    }
  }

  return {
    sam: sam.slice(0, 10),
    kalebt: kalebt.slice(0, 10),
    junrey: junrey.slice(0, 10),
    clay: clay.slice(0, 10),
    daxton: daxton.slice(0, 10),
    totalRecent: recent.length,
  };
}

function main() {
  console.log("Morning report data prep...");

  const projects = loadJSON<Project[]>(join(CACHE, "projects.json"));
  const activeProjectIds = new Set(projects.filter((p) => p.status === "ACTIVE").map((p) => p.id));
  const totalProjects = projects.length;
  const activeCount = activeProjectIds.size;
  console.log(
    `  Projects: ${totalProjects} total, ${activeCount} active (excluded ${totalProjects - activeCount} cancelled/on-hold)`,
  );

  const wos = loadJSON<WO[]>(join(CACHE, "work-orders.json"));
  console.log(`  Loaded ${wos.length} work orders`);

  const woSummary = buildWOSummary(wos, activeProjectIds);
  console.log(`  Open WOs (active projects only): ${woSummary.totalOpen}`);
  for (const [name, items] of Object.entries(woSummary.byEmployee)) {
    console.log(`    ${name}: ${items.topWOs?.length} top items`);
  }

  let emailBrief: ReturnType<typeof buildEmailBrief> = {
    sam: [],
    kalebt: [],
    junrey: [],
    clay: [],
    daxton: [],
    totalRecent: 0,
  };
  if (existsSync(EMAIL_ARCHIVE)) {
    const archive = loadJSON<{ messages: Email[] }>(EMAIL_ARCHIVE);
    console.log(`  Loaded ${archive.messages.length} emails`);
    emailBrief = buildEmailBrief(archive.messages);
    console.log(`  Recent emails (2 days): ${emailBrief.totalRecent}`);
    console.log(
      `    Sam-relevant: ${emailBrief.sam.length}, Clay-relevant: ${emailBrief.clay.length}, Daxton-relevant: ${emailBrief.daxton.length}`,
    );
  } else {
    console.log("  No email archive found — skipping");
  }

  const brief = {
    generatedAt: new Date().toISOString(),
    date: new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "America/Denver",
    }),
    workOrders: woSummary,
    emails: emailBrief,
  };

  writeFileSync(OUTPUT, JSON.stringify(brief, null, 2));
  console.log(`  Written to ${OUTPUT}`);
  console.log("Done.");
}

main();
