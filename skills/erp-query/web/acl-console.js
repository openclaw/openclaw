const state = {
  policy: null,
  selectedUserId: "",
  agents: [],
};

const el = {
  statusPill: document.getElementById("status-pill"),
  updatedAt: document.getElementById("updated-at"),
  stats: document.getElementById("stats"),
  roles: document.getElementById("roles"),
  users: document.getElementById("users"),
  forms: document.getElementById("forms"),
  roleCount: document.getElementById("role-count"),
  userCount: document.getElementById("user-count"),
  assignForm: document.getElementById("assign-form"),
  assignUserId: document.getElementById("assign-user-id"),
  assignName: document.getElementById("assign-name"),
  assignRole: document.getElementById("assign-role"),
  permissionView: document.getElementById("permission-view"),
  formGroupFilter: document.getElementById("form-group-filter"),
  activeOnly: document.getElementById("active-only"),
  mutationSecretInput: document.getElementById("mutation-secret-input"),
  tokenInput: document.getElementById("token-input"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnSyncForms: document.getElementById("btn-sync-forms"),
  btnSyncUsers: document.getElementById("btn-sync-users"),
  btnInit: document.getElementById("btn-init"),
  btnSetSecret: document.getElementById("btn-set-secret"),
  hardeningAgentId: document.getElementById("hardening-agent-id"),
  hardeningWecomUserId: document.getElementById("hardening-wecom-user-id"),
  hardeningScriptPath: document.getElementById("hardening-script-path"),
  hardeningForceModel: document.getElementById("hardening-force-model"),
  hardeningRestart: document.getElementById("hardening-restart"),
  hardeningOutput: document.getElementById("hardening-output"),
  btnHardeningRefresh: document.getElementById("btn-hardening-refresh"),
  btnHardeningApply: document.getElementById("btn-hardening-apply"),
};

function authHeaders() {
  const token = (el.tokenInput.value || "").trim();
  if (!token) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

function mutationSecretValue() {
  return (el.mutationSecretInput.value || "").trim();
}

function requireMutationSecretPayload(payload = {}) {
  const mutationSecret = mutationSecretValue();
  if (!mutationSecret) {
    throw new Error("请先填写 ACL 变更密钥。");
  }
  return {
    ...payload,
    mutationSecret,
  };
}

function normalizeUserId(userId) {
  return String(userId || "")
    .trim()
    .toLowerCase();
}

function sanitizeSlug(value) {
  const normalized = normalizeUserId(value);
  if (!normalized) {
    return "wecom-user";
  }
  return normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "wecom-user";
}

function inferAgentIdFromUserId(userId) {
  const normalized = normalizeUserId(userId);
  if (!normalized) {
    return "";
  }
  return `wecom-dm-${normalized}`;
}

function hardeningScriptPathPreview(userId) {
  return `/Users/haruki/openclaw/skills/erp-query/scripts/agent-wrappers/${sanitizeSlug(userId)}-secure-query.sh`;
}

function updateHardeningScriptPreview() {
  const userId = el.hardeningWecomUserId.value.trim();
  el.hardeningScriptPath.value = userId ? hardeningScriptPathPreview(userId) : "";
}

function renderHardeningAgents() {
  const current = el.hardeningAgentId.value;
  const options = state.agents
    .map((item) => {
      const label = item.modelPrimary ? `${item.id} (${item.modelPrimary})` : item.id;
      return `<option value="${item.id}">${label}</option>`;
    })
    .join("");
  el.hardeningAgentId.innerHTML = options || `<option value="">(未找到 agent)</option>`;
  if (current && state.agents.some((item) => item.id === current)) {
    el.hardeningAgentId.value = current;
  }
}

function syncHardeningAgentForUser(userId) {
  const inferredAgentId = inferAgentIdFromUserId(userId);
  if (inferredAgentId && state.agents.some((item) => item.id === inferredAgentId)) {
    el.hardeningAgentId.value = inferredAgentId;
  }
}

async function loadAgents() {
  const payload = await api("/api/agents");
  state.agents = payload.data?.agents || [];
  renderHardeningAgents();
  syncHardeningAgentForUser(el.hardeningWecomUserId.value.trim());
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  const payload = await response
    .json()
    .catch(() => ({ ok: false, error: "Invalid JSON response." }));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function setStatus(text, kind = "neutral") {
  el.statusPill.textContent = text;
  el.statusPill.className = `pill ${kind}`;
}

function fmtNum(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function renderStats() {
  const stats = state.policy?.stats;
  if (!stats) {
    el.stats.innerHTML =
      "<div class='stat'><div class='k'>0</div><div class='v'>无策略</div></div>";
    return;
  }

  const groups = Object.keys(stats.formsByGroup || {}).length;
  el.stats.innerHTML = `
    <div class="stat"><div class="k">${fmtNum(stats.formCount)}</div><div class="v">表单总数</div></div>
    <div class="stat"><div class="k">${fmtNum(stats.roleCount)}</div><div class="v">角色数</div></div>
    <div class="stat"><div class="k">${fmtNum(stats.userCount)}</div><div class="v">用户数</div></div>
    <div class="stat"><div class="k">${fmtNum(groups)}</div><div class="v">业务分组</div></div>
  `;
}

function renderRoles() {
  const roles = state.policy?.roles || [];
  el.roleCount.textContent = String(roles.length);
  el.assignRole.innerHTML = roles
    .map((r) => `<option value="${r.roleId}">${r.roleId}</option>`)
    .join("");

  if (!roles.length) {
    el.roles.innerHTML = `<div class="role-item">暂无角色</div>`;
    return;
  }

  el.roles.innerHTML = roles
    .map((role) => {
      const groups = (role.autoGroups || []).join(", ") || "-";
      const tableText = (role.allowedTables || []).join(", ");
      return `
        <div class="role-item">
          <div class="role-title">
            <span class="role-name">${role.roleId}</span>
            <span class="tiny">${role.allowedVoucherTypes.length} 个表单</span>
          </div>
          <div class="role-meta">${role.description || ""}</div>
          <div class="role-meta">分组: ${groups}</div>
          <div class="role-meta">表: ${tableText}</div>
        </div>
      `;
    })
    .join("");
}

function selectUser(userId) {
  state.selectedUserId = userId;
  renderUsers();
  loadUserPermission(userId);
  el.hardeningWecomUserId.value = userId;
  updateHardeningScriptPreview();
  syncHardeningAgentForUser(userId);
}

function renderUsers() {
  const users = state.policy?.users || [];
  el.userCount.textContent = String(users.length);

  if (!users.length) {
    el.users.innerHTML = `<div class="user-item">暂无用户，先点“同步用户”。</div>`;
    return;
  }

  el.users.innerHTML = users
    .map((user) => {
      const active = state.selectedUserId === user.userId ? " style='border-color:#8abca8'" : "";
      const chips = (user.roles || [])
        .map(
          (roleId) => `
          <span class="chip">
            ${roleId}
            <button data-user="${user.userId}" data-role="${roleId}" class="btn-unassign" title="移除角色">×</button>
          </span>
        `,
        )
        .join("");
      return `
        <div class="user-item"${active}>
          <div class="user-title">
            <span class="user-name">${user.displayName || "(未命名用户)"}</span>
            <button class="btn" data-select-user="${user.userId}">查看权限</button>
          </div>
          <div class="user-meta">userId: ${user.userId}</div>
          <div class="user-meta">状态: ${user.status || "active"}</div>
          <div class="chips">${chips || "<span class='tiny'>未分配角色</span>"}</div>
        </div>
      `;
    })
    .join("");

  el.users.querySelectorAll("[data-select-user]").forEach((btn) => {
    btn.addEventListener("click", () => selectUser(btn.dataset.selectUser));
  });

  el.users.querySelectorAll(".btn-unassign").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.user;
      const roleId = btn.dataset.role;
      try {
        await api("/api/unassign", {
          method: "POST",
          body: JSON.stringify(requireMutationSecretPayload({ userId, roleId })),
        });
        await loadPolicy();
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

function renderGroupFilter() {
  const forms = state.policy?.forms || [];
  const groups = [...new Set(forms.map((item) => item.voucherGroup).filter(Boolean))].sort();
  const selected = el.formGroupFilter.value;
  el.formGroupFilter.innerHTML = `<option value="">全部分组</option>${groups
    .map((g) => `<option value="${g}">${g}</option>`)
    .join("")}`;
  el.formGroupFilter.value = groups.includes(selected) ? selected : "";
}

function renderForms() {
  const forms = state.policy?.forms || [];
  const group = el.formGroupFilter.value;
  const activeOnly = el.activeOnly.checked;

  const filtered = forms.filter((item) => {
    if (group && item.voucherGroup !== group) {
      return false;
    }
    if (activeOnly && item.stopFlag === "Y") {
      return false;
    }
    return true;
  });

  el.forms.innerHTML = filtered
    .slice(0, 300)
    .map(
      (item) => `
      <div class="form-item">
        <div class="user-title">
          <span class="user-name">${item.voucherType} · ${item.voucherName}</span>
          <span class="tiny">${item.voucherGroup}</span>
        </div>
        <div class="form-meta">停用: ${item.stopFlag === "Y" ? "是" : "否"} | 使用量: ${fmtNum(item.usedCount)} | 最近: ${
          item.lastDate || "-"
        }</div>
      </div>
    `,
    )
    .join("");
}

async function loadUserPermission(userId) {
  if (!userId) {
    el.permissionView.textContent = "点击用户后显示详情...";
    return;
  }
  try {
    const payload = await api(`/api/user/${encodeURIComponent(userId)}`);
    el.permissionView.textContent = JSON.stringify(payload.data, null, 2);
  } catch (err) {
    el.permissionView.textContent = `加载失败: ${err.message}`;
  }
}

async function loadPolicy() {
  try {
    setStatus("加载中...", "neutral");
    const payload = await api("/api/policy");
    state.policy = payload.data;

    const ok = Boolean(state.policy?.exists);
    if (!ok) {
      setStatus("未初始化", "error");
      el.updatedAt.textContent = `策略文件: ${state.policy?.policyPath || "-"}`;
    } else {
      setStatus("运行中", "ok");
      const secretConfigured = Boolean(state.policy.security?.mutationSecretConfigured);
      el.updatedAt.textContent = `更新时间: ${state.policy.updatedAt || "-"} | 变更密钥: ${
        secretConfigured ? "已配置" : "未配置"
      }`;
    }

    renderStats();
    renderRoles();
    renderUsers();
    renderGroupFilter();
    renderForms();

    if (state.selectedUserId) {
      await loadUserPermission(state.selectedUserId);
    } else {
      el.permissionView.textContent = "点击用户后显示详情...";
    }
  } catch (err) {
    setStatus("加载失败", "error");
    alert(err.message);
  }
}

el.assignForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const userId = el.assignUserId.value.trim();
  const roleId = el.assignRole.value.trim();
  const displayName = el.assignName.value.trim();
  if (!userId || !roleId) {
    return;
  }
  try {
    await api("/api/assign", {
      method: "POST",
      body: JSON.stringify(requireMutationSecretPayload({ userId, roleId, displayName })),
    });
    el.assignUserId.value = "";
    await loadPolicy();
    selectUser(userId);
  } catch (err) {
    alert(err.message);
  }
});

el.formGroupFilter.addEventListener("change", renderForms);
el.activeOnly.addEventListener("change", renderForms);

el.btnRefresh.addEventListener("click", () => loadPolicy());
el.btnSyncForms.addEventListener("click", async () => {
  try {
    await api("/api/sync/forms", {
      method: "POST",
      body: JSON.stringify(requireMutationSecretPayload({})),
    });
    await loadPolicy();
  } catch (err) {
    alert(err.message);
  }
});
el.btnSyncUsers.addEventListener("click", async () => {
  try {
    await api("/api/sync/users", {
      method: "POST",
      body: JSON.stringify(requireMutationSecretPayload({})),
    });
    await loadPolicy();
  } catch (err) {
    alert(err.message);
  }
});
el.btnInit.addEventListener("click", async () => {
  const ok = confirm("确认重建策略吗？这会覆盖现有角色和分配。");
  if (!ok) {
    return;
  }
  try {
    await api("/api/init", {
      method: "POST",
      body: JSON.stringify(requireMutationSecretPayload({ force: true })),
    });
    state.selectedUserId = "";
    await loadPolicy();
  } catch (err) {
    alert(err.message);
  }
});

el.btnSetSecret.addEventListener("click", async () => {
  const newSecret = prompt("请输入新的 ACL 变更密钥（至少 10 位）:");
  if (!newSecret) {
    return;
  }
  try {
    await api("/api/mutation-secret", {
      method: "POST",
      body: JSON.stringify({
        currentMutationSecret: mutationSecretValue(),
        newMutationSecret: newSecret,
      }),
    });
    el.mutationSecretInput.value = newSecret;
    await loadPolicy();
    alert("变更密钥已更新。");
  } catch (err) {
    alert(err.message);
  }
});

el.hardeningWecomUserId.addEventListener("input", () => {
  const userId = el.hardeningWecomUserId.value.trim();
  updateHardeningScriptPreview();
  syncHardeningAgentForUser(userId);
});

el.btnHardeningRefresh.addEventListener("click", async () => {
  try {
    await loadAgents();
    el.hardeningOutput.textContent = "代理列表已刷新。";
  } catch (err) {
    alert(err.message);
  }
});

el.btnHardeningApply.addEventListener("click", async () => {
  const agentId = el.hardeningAgentId.value.trim();
  const wecomUserId = el.hardeningWecomUserId.value.trim();
  if (!agentId || !wecomUserId) {
    alert("请先选择 agent 并填写企业微信 userId。");
    return;
  }
  try {
    const payload = requireMutationSecretPayload({
      agentId,
      wecomUserId,
      forceOpenaiCodexModel: Boolean(el.hardeningForceModel.checked),
      restartGateway: Boolean(el.hardeningRestart.checked),
    });
    const response = await api("/api/agent-hardening/apply", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    el.hardeningOutput.textContent = JSON.stringify(response.data, null, 2);
    updateHardeningScriptPreview();
    await loadAgents();
  } catch (err) {
    alert(err.message);
  }
});

async function boot() {
  updateHardeningScriptPreview();
  await loadPolicy();
  await loadAgents();
}

boot().catch((err) => {
  setStatus("加载失败", "error");
  alert(err.message);
});
