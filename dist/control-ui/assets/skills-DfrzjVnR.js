import{$ as e,T as t,it as n,p as r,rt as i,tt as a,v as o}from"./index-BtIuF4zW.js";import{i as s,n as c,r as l,t as u}from"./skills-shared-DkqPT6RW.js";function d(e){return e?r(e,window.location.href):null}function f(e){!(e instanceof HTMLDialogElement)||e.open||(e.isConnected?e.showModal():queueMicrotask(()=>{e.isConnected&&!e.open&&e.showModal()}))}var p=[{id:`all`,label:`All`},{id:`ready`,label:`Ready`},{id:`needs-setup`,label:`Needs Setup`},{id:`disabled`,label:`Disabled`}];function m(e,t){switch(t){case`all`:return!0;case`ready`:return!e.disabled&&e.eligible;case`needs-setup`:return!e.disabled&&!e.eligible;case`disabled`:return e.disabled}throw Error(`Unsupported skills status filter`)}function h(e){return e.disabled?`muted`:e.eligible?`ok`:`warn`}function g(t){let r=t.report?.skills??[],o={all:r.length,ready:0,"needs-setup":0,disabled:0};for(let e of r)e.disabled?o.disabled++:e.eligible?o.ready++:o[`needs-setup`]++;let c=t.statusFilter===`all`?r:r.filter(e=>m(e,t.statusFilter)),l=e(t.filter),u=l?c.filter(t=>e([t.name,t.description,t.source].join(` `)).includes(l)):c,d=s(u),f=t.detailKey?r.find(e=>e.skillKey===t.detailKey)??null:null;return n`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Skills</div>
          <div class="card-sub">Installed skills and their status.</div>
        </div>
        <button
          class="btn"
          ?disabled=${t.loading||!t.connected}
          @click=${t.onRefresh}
        >
          ${t.loading?a(`common.loading`):a(`common.refresh`)}
        </button>
      </div>

      <div class="agent-tabs" style="margin-top: 14px;">
        ${p.map(e=>n`
            <button
              class="agent-tab ${t.statusFilter===e.id?`active`:``}"
              @click=${()=>t.onStatusFilterChange(e.id)}
            >
              ${e.label}<span class="agent-tab-count">${o[e.id]}</span>
            </button>
          `)}
      </div>

      <div
        class="filters"
        style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px;"
      >
        <label class="field" style="flex: 1; min-width: 180px;">
          <input
            .value=${t.filter}
            @input=${e=>t.onFilterChange(e.target.value)}
            placeholder="Filter installed skills"
            autocomplete="off"
            name="skills-filter"
          />
        </label>
        <div class="muted">${u.length} shown</div>
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
              .value=${t.clawhubQuery}
              @input=${e=>t.onClawHubQueryChange(e.target.value)}
              placeholder="Search ClawHub skills…"
              autocomplete="off"
              name="clawhub-search"
            />
          </label>
          ${t.clawhubSearchLoading?n`<span class="muted">Searching…</span>`:i}
        </div>
        ${t.clawhubSearchError?n`<div class="callout danger" style="margin-top: 8px;">
              ${t.clawhubSearchError}
            </div>`:i}
        ${t.clawhubInstallMessage?n`<div
              class="callout ${t.clawhubInstallMessage.kind===`error`?`danger`:`success`}"
              style="margin-top: 8px;"
            >
              ${t.clawhubInstallMessage.text}
            </div>`:i}
        ${_(t)}
      </div>

      ${t.error?n`<div class="callout danger" style="margin-top: 12px;">${t.error}</div>`:i}
      ${u.length===0?n`
            <div class="muted" style="margin-top: 16px">
              ${!t.connected&&!t.report?`Not connected to gateway.`:`No skills found.`}
            </div>
          `:n`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${d.map(e=>n`
                  <details class="agent-skills-group" open>
                    <summary class="agent-skills-header">
                      <span>${e.label}</span>
                      <span class="muted">${e.skills.length}</span>
                    </summary>
                    <div class="list skills-grid">
                      ${e.skills.map(e=>y(e,t))}
                    </div>
                  </details>
                `)}
            </div>
          `}
    </section>

    ${f?b(f,t):i}
    ${t.clawhubDetailSlug?v(t):i}
  `}function _(e){let r=e.clawhubResults;return r?r.length===0?n`<div class="muted" style="margin-top: 8px;">No skills found on ClawHub.</div>`:n`
    <div class="list" style="margin-top: 8px;">
      ${r.map(r=>n`
          <div
            class="list-item list-item-clickable"
            @click=${()=>e.onClawHubDetailOpen(r.slug)}
          >
            <div class="list-main">
              <div class="list-title">${r.displayName}</div>
              <div class="list-sub">${r.summary?t(r.summary,120):r.slug}</div>
            </div>
            <div class="list-meta" style="display: flex; align-items: center; gap: 8px;">
              ${r.version?n`<span class="muted" style="font-size: 12px;">v${r.version}</span>`:i}
              <button
                class="btn btn--sm"
                ?disabled=${e.clawhubInstallSlug!==null}
                @click=${t=>{t.stopPropagation(),e.onClawHubInstall(r.slug)}}
              >
                ${e.clawhubInstallSlug===r.slug?`Installing…`:`Install`}
              </button>
            </div>
          </div>
        `)}
    </div>
  `:i}function v(e){let t=e.clawhubDetail;return n`
    <dialog
      class="md-preview-dialog"
      ${o(f)}
      @click=${e=>{let t=e.currentTarget;e.target===t&&t.close()}}
      @close=${e.onClawHubDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div class="md-preview-dialog__title">
            ${t?.skill?.displayName??e.clawhubDetailSlug}
          </div>
          <button
            class="btn btn--sm"
            @click=${e=>{e.currentTarget.closest(`dialog`)?.close()}}
          >
            Close
          </button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 16px;">
          ${e.clawhubDetailLoading?n`<div class="muted">${a(`common.loading`)}</div>`:e.clawhubDetailError?n`<div class="callout danger">${e.clawhubDetailError}</div>`:t?.skill?n`
                    <div style="font-size: 14px; line-height: 1.5;">
                      ${t.skill.summary??``}
                    </div>
                    ${t.owner?.displayName?n`<div class="muted" style="font-size: 13px;">
                          By
                          ${t.owner.displayName}${t.owner.handle?n` (@${t.owner.handle})`:i}
                        </div>`:i}
                    ${t.latestVersion?n`<div class="muted" style="font-size: 13px;">
                          Latest: v${t.latestVersion.version}
                        </div>`:i}
                    ${t.latestVersion?.changelog?n`<div
                          style="font-size: 13px; border-top: 1px solid var(--border); padding-top: 12px; white-space: pre-wrap;"
                        >
                          ${t.latestVersion.changelog}
                        </div>`:i}
                    ${t.metadata?.os?n`<div class="muted" style="font-size: 12px;">
                          Platforms: ${t.metadata.os.join(`, `)}
                        </div>`:i}
                    <button
                      class="btn primary"
                      ?disabled=${e.clawhubInstallSlug!==null}
                      @click=${()=>{e.clawhubDetailSlug&&e.onClawHubInstall(e.clawhubDetailSlug)}}
                    >
                      ${e.clawhubInstallSlug===e.clawhubDetailSlug?`Installing…`:`Install ${t.skill.displayName}`}
                    </button>
                  `:n`<div class="muted">Skill not found.</div>`}
        </div>
      </div>
    </dialog>
  `}function y(e,r){let a=r.busyKey===e.skillKey;return n`
    <div class="list-item list-item-clickable" @click=${()=>r.onDetailOpen(e.skillKey)}>
      <div class="list-main">
        <div class="list-title" style="display: flex; align-items: center; gap: 8px;">
          <span class="statusDot ${h(e)}"></span>
          ${e.emoji?n`<span>${e.emoji}</span>`:i}
          <span>${e.name}</span>
        </div>
        <div class="list-sub">${t(e.description,140)}</div>
      </div>
      <div
        class="list-meta"
        style="display: flex; align-items: center; justify-content: flex-end; gap: 10px;"
      >
        <label class="skill-toggle-wrap" @click=${e=>e.stopPropagation()}>
          <input
            type="checkbox"
            class="skill-toggle"
            .checked=${!e.disabled}
            ?disabled=${a}
            @change=${t=>{t.stopPropagation(),r.onToggle(e.skillKey,e.disabled)}}
          />
        </label>
      </div>
    </div>
  `}function b(e,t){let r=t.busyKey===e.skillKey,a=t.edits[e.skillKey]??``,s=t.messages[e.skillKey]??null,p=e.install.length>0&&e.missing.bins.length>0,m=!!(e.bundled&&e.source!==`openclaw-bundled`),g=u(e),_=c(e);return n`
    <dialog
      class="md-preview-dialog"
      ${o(f)}
      @click=${e=>{let t=e.currentTarget;e.target===t&&t.close()}}
      @close=${t.onDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div
            class="md-preview-dialog__title"
            style="display: flex; align-items: center; gap: 8px;"
          >
            <span class="statusDot ${h(e)}"></span>
            ${e.emoji?n`<span style="font-size: 18px;">${e.emoji}</span>`:i}
            <span>${e.name}</span>
          </div>
          <button
            class="btn btn--sm"
            @click=${e=>{e.currentTarget.closest(`dialog`)?.close()}}
          >
            Close
          </button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 16px;">
          <div>
            <div style="font-size: 14px; line-height: 1.5; color: var(--text);">
              ${e.description}
            </div>
            ${l({skill:e,showBundledBadge:m})}
          </div>

          ${g.length>0?n`
                <div
                  class="callout"
                  style="border-color: var(--warn-subtle); background: var(--warn-subtle); color: var(--warn);"
                >
                  <div style="font-weight: 600; margin-bottom: 4px;">Missing requirements</div>
                  <div>${g.join(`, `)}</div>
                </div>
              `:i}
          ${_.length>0?n`
                <div class="muted" style="font-size: 13px;">Reason: ${_.join(`, `)}</div>
              `:i}

          <div style="display: flex; align-items: center; gap: 12px;">
            <label class="skill-toggle-wrap">
              <input
                type="checkbox"
                class="skill-toggle"
                .checked=${!e.disabled}
                ?disabled=${r}
                @change=${()=>t.onToggle(e.skillKey,e.disabled)}
              />
            </label>
            <span style="font-size: 13px; font-weight: 500;">
              ${e.disabled?`Disabled`:`Enabled`}
            </span>
            ${p?n`<button
                  class="btn"
                  ?disabled=${r}
                  @click=${()=>t.onInstall(e.skillKey,e.name,e.install[0].id)}
                >
                  ${r?`Installing…`:e.install[0].label}
                </button>`:i}
          </div>

          ${s?n`<div class="callout ${s.kind===`error`?`danger`:`success`}">
                ${s.message}
              </div>`:i}
          ${e.primaryEnv?n`
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
                      .value=${a}
                      @input=${n=>t.onEdit(e.skillKey,n.target.value)}
                    />
                  </div>
                  ${(()=>{let t=d(e.homepage);return t?n`<div class="muted" style="font-size: 13px;">
                          Get your key:
                          <a href="${t}" target="_blank" rel="noopener noreferrer"
                            >${e.homepage}</a
                          >
                        </div>`:i})()}
                  <button
                    class="btn primary"
                    ?disabled=${r}
                    @click=${()=>t.onSaveKey(e.skillKey)}
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
            ${(()=>{let t=d(e.homepage);return t?n`<div>
                    <a href="${t}" target="_blank" rel="noopener noreferrer"
                      >${e.homepage}</a
                    >
                  </div>`:i})()}
          </div>
        </div>
      </div>
    </dialog>
  `}export{g as renderSkills};
//# sourceMappingURL=skills-DfrzjVnR.js.map