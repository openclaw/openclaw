import{B as b,A as i,t as g,f as a,V as y,$,a0 as h}from"./index-B38_p15v.js";import{g as w,c as x,a as S,r as k}from"./skills-shared-C6Xe0uSS.js";function m(e){return e?h(e,window.location.href):null}function p(e){!(e instanceof HTMLDialogElement)||e.open||e.showModal()}const C=[{id:"all",label:"All"},{id:"ready",label:"Ready"},{id:"needs-setup",label:"Needs Setup"},{id:"disabled",label:"Disabled"}];function D(e,l){switch(l){case"all":return!0;case"ready":return!e.disabled&&e.eligible;case"needs-setup":return!e.disabled&&!e.eligible;case"disabled":return e.disabled}throw new Error("Unsupported skills status filter")}function f(e){return e.disabled?"muted":e.eligible?"ok":"warn"}function T(e){const l=e.report?.skills??[],t={all:l.length,ready:0,"needs-setup":0,disabled:0};for(const s of l)s.disabled?t.disabled++:s.eligible?t.ready++:t["needs-setup"]++;const d=e.statusFilter==="all"?l:l.filter(s=>D(s,e.statusFilter)),o=b(e.filter),c=o?d.filter(s=>b([s.name,s.description,s.source].join(" ")).includes(o)):d,u=w(c),r=e.detailKey?l.find(s=>s.skillKey===e.detailKey)??null:null;return a`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Skills</div>
          <div class="card-sub">Installed skills and their status.</div>
        </div>
        <button
          class="btn"
          ?disabled=${e.loading||!e.connected}
          @click=${e.onRefresh}
        >
          ${e.loading?g("common.loading"):g("common.refresh")}
        </button>
      </div>

      <div class="agent-tabs" style="margin-top: 14px;">
        ${C.map(s=>a`
            <button
              class="agent-tab ${e.statusFilter===s.id?"active":""}"
              @click=${()=>e.onStatusFilterChange(s.id)}
            >
              ${s.label}<span class="agent-tab-count">${t[s.id]}</span>
            </button>
          `)}
      </div>

      <div
        class="filters"
        style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px;"
      >
        <label class="field" style="flex: 1; min-width: 180px;">
          <input
            .value=${e.filter}
            @input=${s=>e.onFilterChange(s.target.value)}
            placeholder="Filter installed skills"
            autocomplete="off"
            name="skills-filter"
          />
        </label>
        <div class="muted">${c.length} shown</div>
      </div>

      <div style="margin-top: 16px; border-top: 1px solid var(--border); padding-top: 16px;">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
          <div style="font-weight: 600;">ClawHub</div>
          <div class="muted" style="font-size: 13px;">
            Search and install skills from the registry
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
          <label class="field" style="flex: 1; min-width: 180px;">
            <input
              .value=${e.clawhubQuery}
              @input=${s=>e.onClawHubQueryChange(s.target.value)}
              placeholder="Search ClawHub skills…"
              autocomplete="off"
              name="clawhub-search"
            />
          </label>
          ${e.clawhubSearchLoading?a`<span class="muted">Searching…</span>`:i}
        </div>
        ${e.clawhubSearchError?a`<div class="callout danger" style="margin-top: 8px;">
              ${e.clawhubSearchError}
            </div>`:i}
        ${e.clawhubInstallMessage?a`<div
              class="callout ${e.clawhubInstallMessage.kind==="error"?"danger":"success"}"
              style="margin-top: 8px;"
            >
              ${e.clawhubInstallMessage.text}
            </div>`:i}
        ${_(e)}
      </div>

      ${e.error?a`<div class="callout danger" style="margin-top: 12px;">${e.error}</div>`:i}
      ${c.length===0?a`
            <div class="muted" style="margin-top: 16px">
              ${!e.connected&&!e.report?"Not connected to gateway.":"No skills found."}
            </div>
          `:a`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${u.map(s=>a`
                  <details class="agent-skills-group" open>
                    <summary class="agent-skills-header">
                      <span>${s.label}</span>
                      <span class="muted">${s.skills.length}</span>
                    </summary>
                    <div class="list skills-grid">
                      ${s.skills.map(n=>K(n,e))}
                    </div>
                  </details>
                `)}
            </div>
          `}
    </section>

    ${r?z(r,e):i}
    ${e.clawhubDetailSlug?I(e):i}
  `}function _(e){const l=e.clawhubResults;return l?l.length===0?a`<div class="muted" style="margin-top: 8px;">No skills found on ClawHub.</div>`:a`
    <div class="list" style="margin-top: 8px;">
      ${l.map(t=>a`
          <div
            class="list-item list-item-clickable"
            @click=${()=>e.onClawHubDetailOpen(t.slug)}
          >
            <div class="list-main">
              <div class="list-title">${t.displayName}</div>
              <div class="list-sub">${t.summary?y(t.summary,120):t.slug}</div>
            </div>
            <div class="list-meta" style="display: flex; align-items: center; gap: 8px;">
              ${t.version?a`<span class="muted" style="font-size: 12px;">v${t.version}</span>`:i}
              <button
                class="btn btn--sm"
                ?disabled=${e.clawhubInstallSlug!==null}
                @click=${d=>{d.stopPropagation(),e.onClawHubInstall(t.slug)}}
              >
                ${e.clawhubInstallSlug===t.slug?"Installing…":"Install"}
              </button>
            </div>
          </div>
        `)}
    </div>
  `:i}function I(e){const l=e.clawhubDetail;return a`
    <dialog
      class="md-preview-dialog"
      ${$(p)}
      @click=${t=>{const d=t.currentTarget;t.target===d&&d.close()}}
      @close=${e.onClawHubDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div class="md-preview-dialog__title">
            ${l?.skill?.displayName??e.clawhubDetailSlug}
          </div>
          <button
            class="btn btn--sm"
            @click=${t=>{t.currentTarget.closest("dialog")?.close()}}
          >
            Close
          </button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 16px;">
          ${e.clawhubDetailLoading?a`<div class="muted">${g("common.loading")}</div>`:e.clawhubDetailError?a`<div class="callout danger">${e.clawhubDetailError}</div>`:l?.skill?a`
                    <div style="font-size: 14px; line-height: 1.5;">
                      ${l.skill.summary??""}
                    </div>
                    ${l.owner?.displayName?a`<div class="muted" style="font-size: 13px;">
                          By
                          ${l.owner.displayName}${l.owner.handle?a` (@${l.owner.handle})`:i}
                        </div>`:i}
                    ${l.latestVersion?a`<div class="muted" style="font-size: 13px;">
                          Latest: v${l.latestVersion.version}
                        </div>`:i}
                    ${l.latestVersion?.changelog?a`<div
                          style="font-size: 13px; border-top: 1px solid var(--border); padding-top: 12px; white-space: pre-wrap;"
                        >
                          ${l.latestVersion.changelog}
                        </div>`:i}
                    ${l.metadata?.os?a`<div class="muted" style="font-size: 12px;">
                          Platforms: ${l.metadata.os.join(", ")}
                        </div>`:i}
                    <button
                      class="btn primary"
                      ?disabled=${e.clawhubInstallSlug!==null}
                      @click=${()=>{e.clawhubDetailSlug&&e.onClawHubInstall(e.clawhubDetailSlug)}}
                    >
                      ${e.clawhubInstallSlug===e.clawhubDetailSlug?"Installing…":`Install ${l.skill.displayName}`}
                    </button>
                  `:a`<div class="muted">Skill not found.</div>`}
        </div>
      </div>
    </dialog>
  `}function K(e,l){const t=l.busyKey===e.skillKey,d=f(e);return a`
    <div class="list-item list-item-clickable" @click=${()=>l.onDetailOpen(e.skillKey)}>
      <div class="list-main">
        <div class="list-title" style="display: flex; align-items: center; gap: 8px;">
          <span class="statusDot ${d}"></span>
          ${e.emoji?a`<span>${e.emoji}</span>`:i}
          <span>${e.name}</span>
        </div>
        <div class="list-sub">${y(e.description,140)}</div>
      </div>
      <div
        class="list-meta"
        style="display: flex; align-items: center; justify-content: flex-end; gap: 10px;"
      >
        <label class="skill-toggle-wrap" @click=${o=>o.stopPropagation()}>
          <input
            type="checkbox"
            class="skill-toggle"
            .checked=${!e.disabled}
            ?disabled=${t}
            @change=${o=>{o.stopPropagation(),l.onToggle(e.skillKey,e.disabled)}}
          />
        </label>
      </div>
    </div>
  `}function z(e,l){const t=l.busyKey===e.skillKey,d=l.edits[e.skillKey]??"",o=l.messages[e.skillKey]??null,c=e.install.length>0&&e.missing.bins.length>0,u=!!(e.bundled&&e.source!=="openclaw-bundled"),r=x(e),s=S(e);return a`
    <dialog
      class="md-preview-dialog"
      ${$(p)}
      @click=${n=>{const v=n.currentTarget;n.target===v&&v.close()}}
      @close=${l.onDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div
            class="md-preview-dialog__title"
            style="display: flex; align-items: center; gap: 8px;"
          >
            <span class="statusDot ${f(e)}"></span>
            ${e.emoji?a`<span style="font-size: 18px;">${e.emoji}</span>`:i}
            <span>${e.name}</span>
          </div>
          <button
            class="btn btn--sm"
            @click=${n=>{n.currentTarget.closest("dialog")?.close()}}
          >
            Close
          </button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 16px;">
          <div>
            <div style="font-size: 14px; line-height: 1.5; color: var(--text);">
              ${e.description}
            </div>
            ${k({skill:e,showBundledBadge:u})}
          </div>

          ${r.length>0?a`
                <div
                  class="callout"
                  style="border-color: var(--warn-subtle); background: var(--warn-subtle); color: var(--warn);"
                >
                  <div style="font-weight: 600; margin-bottom: 4px;">Missing requirements</div>
                  <div>${r.join(", ")}</div>
                </div>
              `:i}
          ${s.length>0?a`
                <div class="muted" style="font-size: 13px;">Reason: ${s.join(", ")}</div>
              `:i}

          <div style="display: flex; align-items: center; gap: 12px;">
            <label class="skill-toggle-wrap">
              <input
                type="checkbox"
                class="skill-toggle"
                .checked=${!e.disabled}
                ?disabled=${t}
                @change=${()=>l.onToggle(e.skillKey,e.disabled)}
              />
            </label>
            <span style="font-size: 13px; font-weight: 500;">
              ${e.disabled?"Disabled":"Enabled"}
            </span>
            ${c?a`<button
                  class="btn"
                  ?disabled=${t}
                  @click=${()=>l.onInstall(e.skillKey,e.name,e.install[0].id)}
                >
                  ${t?"Installing…":e.install[0].label}
                </button>`:i}
          </div>

          ${o?a`<div class="callout ${o.kind==="error"?"danger":"success"}">
                ${o.message}
              </div>`:i}
          ${e.primaryEnv?a`
                <div style="display: grid; gap: 8px;">
                  <div class="field">
                    <span
                      >API key
                      <span class="muted" style="font-weight: normal; font-size: 0.88em;"
                        >(${e.primaryEnv})</span
                      ></span
                    >
                    <input
                      type="password"
                      .value=${d}
                      @input=${n=>l.onEdit(e.skillKey,n.target.value)}
                    />
                  </div>
                  ${(()=>{const n=m(e.homepage);return n?a`<div class="muted" style="font-size: 13px;">
                          Get your key:
                          <a href="${n}" target="_blank" rel="noopener noreferrer"
                            >${e.homepage}</a
                          >
                        </div>`:i})()}
                  <button
                    class="btn primary"
                    ?disabled=${t}
                    @click=${()=>l.onSaveKey(e.skillKey)}
                  >
                    Save key
                  </button>
                </div>
              `:i}

          <div
            style="border-top: 1px solid var(--border); padding-top: 12px; display: grid; gap: 6px; font-size: 12px; color: var(--muted);"
          >
            <div><span style="font-weight: 600;">Source:</span> ${e.source}</div>
            <div style="font-family: var(--mono); word-break: break-all;">${e.filePath}</div>
            ${(()=>{const n=m(e.homepage);return n?a`<div>
                    <a href="${n}" target="_blank" rel="noopener noreferrer"
                      >${e.homepage}</a
                    >
                  </div>`:i})()}
          </div>
        </div>
      </div>
    </dialog>
  `}export{T as renderSkills};
//# sourceMappingURL=skills-DSr_NNtO.js.map
