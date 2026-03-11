const STORAGE_KEYS = {
  pilotProject: "openclaw.pilot.project",
  pilotParcel: "openclaw.pilot.parcel",
  pilotJurisdiction: "openclaw.pilot.jurisdiction",
  pilotRunnerLog: "openclaw.pilot.runner.log",
  genericChat: "openclaw.chat.generic",
};

function readJson(key) {
  const raw = localStorage.getItem(key);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function readFormString(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function ensureGenericChatStore() {
  if (readJson(STORAGE_KEYS.genericChat)) {
    return;
  }

  writeJson(STORAGE_KEYS.genericChat, {
    threadId: "generic-main",
    messageCount: 4,
    updatedAt: new Date().toISOString(),
  });
}

function formatSavedPilotContext() {
  const project = readJson(STORAGE_KEYS.pilotProject);
  const parcel = readJson(STORAGE_KEYS.pilotParcel);
  const jurisdiction = readJson(STORAGE_KEYS.pilotJurisdiction);

  if (!project || !parcel || !jurisdiction) {
    return null;
  }

  return { project, parcel, jurisdiction };
}

function inferJurisdiction(address, override) {
  const normalizedOverride = override.trim();
  if (normalizedOverride.length > 0) {
    return normalizedOverride;
  }

  const stateMatch = address.match(/,\s*([A-Za-z]{2})\b/);
  if (stateMatch) {
    return `${stateMatch[1].toUpperCase()} inferred jurisdiction`;
  }

  return "Local jurisdiction (inferred)";
}

function initDashboard() {
  const filterButtons = Array.from(document.querySelectorAll("[data-filter]"));
  const ticketCards = Array.from(document.querySelectorAll(".ticket-card"));
  const emptyState = document.querySelector("[data-testid='empty-state']");
  const summaryTitle = document.querySelector("[data-testid='summary-title']");
  const summaryBody = document.querySelector("[data-testid='summary-body']");
  const summaryEyebrow = document.querySelector(".summary-card__eyebrow");
  const emptyStateTitle = emptyState?.querySelector("h2");
  const emptyStateBody = emptyState?.querySelector("p");
  const launchPilotChatButton = document.querySelector("[data-testid='launch-pilot-chat']");
  const pilotContextNode = document.querySelector("[data-testid='pilot-context']");

  const filterContent = {
    all: {
      summaryTitle: "All tickets",
      summaryBody: "Showing every active ticket waiting in the pilot queue.",
      emptyTitle: "No tickets available",
      emptyBody: "Pick another filter when this queue is empty.",
    },
    ready: {
      summaryTitle: "Ready tickets",
      summaryBody: "These pilot tasks have complete intake data and can run discovery now.",
      emptyTitle: "No ready tickets",
      emptyBody: "Everything queued right now is either blocked or waiting for review.",
    },
    blocked: {
      summaryTitle: "Blocked tickets",
      summaryBody:
        "These tasks need source revalidation, evidence updates, or a concrete unblocker.",
      emptyTitle: "No blocked tickets",
      emptyBody: "Blocked work is clear for now. Monitor new runs for regressions.",
    },
    review: {
      summaryTitle: "Review tickets",
      summaryBody: "Independent review tasks are waiting for QA, UX, or AI follow-up.",
      emptyTitle: "No tickets in review",
      emptyBody: "Everything currently in queue is either ready or blocked.",
    },
  };

  function applyFilter(nextFilter) {
    // Keep UI state coherent even if a malformed filter value is passed in.
    const activeFilter = Object.hasOwn(filterContent, nextFilter) ? nextFilter : "all";

    for (const button of filterButtons) {
      const isActive = button.dataset.filter === activeFilter;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    }

    let visibleCards = 0;
    for (const card of ticketCards) {
      const matches = activeFilter === "all" || card.dataset.status === activeFilter;
      card.hidden = !matches;
      if (matches) {
        visibleCards += 1;
      }
    }

    const content = filterContent[activeFilter];
    if (summaryTitle) {
      summaryTitle.textContent = content.summaryTitle;
    }
    if (summaryBody) {
      summaryBody.textContent = content.summaryBody;
    }
    if (summaryEyebrow) {
      summaryEyebrow.textContent = `${visibleCards} of ${ticketCards.length} visible`;
    }

    if (emptyState) {
      const hasVisibleCards = visibleCards > 0;
      emptyState.hidden = hasVisibleCards;
      if (!hasVisibleCards) {
        if (emptyStateTitle) {
          emptyStateTitle.textContent = content.emptyTitle;
        }
        if (emptyStateBody) {
          emptyStateBody.textContent = content.emptyBody;
        }
      }
    }
  }

  for (const button of filterButtons) {
    button.addEventListener("click", () => {
      const nextFilter = button.dataset.filter ?? "all";
      applyFilter(nextFilter);
    });
  }

  const pilotContext = formatSavedPilotContext();
  if (pilotContextNode) {
    if (pilotContext) {
      pilotContextNode.textContent = `Saved pilot: ${pilotContext.project.name} (${pilotContext.project.scope}) • parcel ${pilotContext.parcel.parcelId} • ${pilotContext.jurisdiction.name}`;
    } else {
      pilotContextNode.textContent =
        "No pilot project saved yet. Use /pilot/project to capture parcel and scope.";
    }
  }

  if (launchPilotChatButton) {
    launchPilotChatButton.toggleAttribute("disabled", !pilotContext);
    launchPilotChatButton.addEventListener("click", () => {
      if (!pilotContext) {
        return;
      }
      window.location.assign("/pilot/chat/index.html");
    });
  }

  applyFilter("all");
}

function initProjectIntake() {
  const form = document.querySelector("[data-testid='project-intake-form']");
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  const resultPanel = document.querySelector("[data-testid='project-result']");
  const resultProject = document.querySelector("[data-testid='result-project']");
  const resultParcel = document.querySelector("[data-testid='result-parcel']");
  const resultJurisdiction = document.querySelector("[data-testid='result-jurisdiction']");
  const resultStorage = document.querySelector("[data-testid='result-storage']");
  const openPilotChatLink = document.querySelector("[data-testid='open-pilot-chat']");

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const formData = new FormData(form);
    const projectName = readFormString(formData, "projectName");
    const parcelId = readFormString(formData, "parcelId");
    const address = readFormString(formData, "address");
    const projectScope = readFormString(formData, "projectScope");
    const jurisdictionOverride = readFormString(formData, "jurisdictionOverride");

    const createdAt = new Date().toISOString();
    const projectId = `pilot-${Date.now()}`;
    const jurisdictionName = inferJurisdiction(address, jurisdictionOverride);

    const projectRecord = {
      id: projectId,
      name: projectName,
      scope: projectScope,
      createdAt,
    };
    const parcelRecord = {
      parcelId,
      address,
      linkedProjectId: projectId,
      createdAt,
    };
    const jurisdictionRecord = {
      name: jurisdictionName,
      source: jurisdictionOverride ? "manual" : "address-inferred",
      linkedProjectId: projectId,
      createdAt,
    };

    writeJson(STORAGE_KEYS.pilotProject, projectRecord);
    writeJson(STORAGE_KEYS.pilotParcel, parcelRecord);
    writeJson(STORAGE_KEYS.pilotJurisdiction, jurisdictionRecord);

    if (resultProject) {
      resultProject.textContent = `Project: ${projectRecord.name} (${projectRecord.scope})`;
    }
    if (resultParcel) {
      resultParcel.textContent = `Parcel: ${parcelRecord.parcelId} — ${parcelRecord.address}`;
    }
    if (resultJurisdiction) {
      resultJurisdiction.textContent = `Jurisdiction: ${jurisdictionRecord.name}`;
    }
    if (resultStorage) {
      resultStorage.textContent =
        "Saved records: openclaw.pilot.project, openclaw.pilot.parcel, openclaw.pilot.jurisdiction";
    }
    if (openPilotChatLink instanceof HTMLAnchorElement) {
      openPilotChatLink.href = `/pilot/chat/index.html?projectId=${encodeURIComponent(projectId)}`;
    }
    if (resultPanel instanceof HTMLElement) {
      resultPanel.hidden = false;
    }
  });
}

function initPilotChat() {
  const chatContext = document.querySelector("[data-testid='chat-context']");
  const genericChatStatus = document.querySelector("[data-testid='generic-chat-status']");
  const simulateRunnerButton = document.querySelector("[data-testid='simulate-runner']");
  const runnerLogNode = document.querySelector("[data-testid='runner-log']");

  const pilotContext = formatSavedPilotContext();
  const genericChatStore = readJson(STORAGE_KEYS.genericChat);
  const runnerLog = readJson(STORAGE_KEYS.pilotRunnerLog) ?? [];

  if (chatContext) {
    if (pilotContext) {
      chatContext.textContent = `Runner booted with project ${pilotContext.project.name}, parcel ${pilotContext.parcel.parcelId}, and ${pilotContext.jurisdiction.name}.`;
    } else {
      chatContext.textContent =
        "No saved pilot context found. Return to /pilot/project and create a project first.";
    }
  }

  if (genericChatStatus) {
    if (genericChatStore) {
      genericChatStatus.textContent = `Generic chat store remains separate (${genericChatStore.threadId}, ${genericChatStore.messageCount} messages).`;
    } else {
      genericChatStatus.textContent = "Generic chat store is missing.";
    }
  }

  function renderRunnerLog() {
    if (!(runnerLogNode instanceof HTMLOListElement)) {
      return;
    }

    runnerLogNode.innerHTML = "";
    for (const entry of runnerLog) {
      const item = document.createElement("li");
      item.textContent = entry;
      runnerLogNode.append(item);
    }
  }

  renderRunnerLog();

  if (simulateRunnerButton instanceof HTMLButtonElement) {
    simulateRunnerButton.disabled = !pilotContext;
    simulateRunnerButton.addEventListener("click", () => {
      if (!pilotContext) {
        return;
      }

      const eventStamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      runnerLog.push(
        `${eventStamp} — discovery run launched for ${pilotContext.project.name} (${pilotContext.parcel.parcelId})`,
      );
      writeJson(STORAGE_KEYS.pilotRunnerLog, runnerLog);
      renderRunnerLog();
    });
  }
}

function boot() {
  ensureGenericChatStore();

  const page = document.body.dataset.page;
  if (page === "pilot-dashboard") {
    initDashboard();
    return;
  }

  if (page === "project-intake") {
    initProjectIntake();
    return;
  }

  if (page === "pilot-chat") {
    initPilotChat();
  }
}

boot();
