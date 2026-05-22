import{Q as e,et as t,nt as n,p as r,rt as i,v as a,w as o}from"./index-BpQmAwow.js";import{i as s,n as c,r as l,t as u}from"./skills-shared-BvYGH17F.js";function d(e){return e?r(e,window.location.href):null}function f(e){!(e instanceof HTMLDialogElement)||e.open||(e.isConnected?e.showModal():queueMicrotask(()=>{e.isConnected&&!e.open&&e.showModal()}))}var p=[{id:`all`,label:`All`},{id:`ready`,label:`Ready`},{id:`needs-setup`,label:`Needs Setup`},{id:`disabled`,label:`Disabled`}];function m(e,t){switch(t){case`all`:return!0;case`ready`:return!e.disabled&&e.eligible;case`needs-setup`:return!e.disabled&&!e.eligible;case`disabled`:return e.disabled}throw Error(`Unsupported skills status filter`)}function h(e){return e.disabled?`muted`:e.eligible?`ok`:`warn`}function g(r){let a=r.report?.skills??[],o={all:a.length,ready:0,"needs-setup":0,disabled:0};for(let e of a)e.disabled?o.disabled++:e.eligible?o.ready++:o[`needs-setup`]++;let c=r.statusFilter===`all`?a:a.filter(e=>m(e,r.statusFilter)),l=e(r.filter),u=l?c.filter(t=>e([t.name,t.description,t.source].join(` `)).includes(l)):c,d=s(u),f=r.detailKey?a.find(e=>e.skillKey===r.detailKey)??null:null;return i`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Skills</div>
          <div class="card-sub">Installed skills and their status.</div>
        </div>
        <button
          class="btn"
          ?disabled=${r.loading||!r.connected}
          @click=${r.onRefresh}
        >
          ${r.loading?t(`common.loading`):t(`common.refresh`)}
        </button>
      </div>

      <div class="agent-tabs" style="margin-top: 14px;">
        ${p.map(e=>i`
            <button
              class="agent-tab ${r.statusFilter===e.id?`active`:``}"
              @click=${()=>r.onStatusFilterChange(e.id)}
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
            .value=${r.filter}
            @input=${e=>r.onFilterChange(e.target.value)}
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
              .value=${r.clawhubQuery}
              @input=${e=>r.onClawHubQueryChange(e.target.value)}
              placeholder="Search ClawHub skills…"
              autocomplete="off"
              name="clawhub-search"
            />
          </label>
          ${r.clawhubSearchLoading?i`<span class="muted">Searching…</span>`:n}
        </div>
        ${r.clawhubSearchError?i`<div class="callout danger" style="margin-top: 8px;">
              ${r.clawhubSearchError}
            </div>`:n}
        ${r.clawhubInstallMessage?i`<div
              class="callout ${r.clawhubInstallMessage.kind===`error`?`danger`:`success`}"
              style="margin-top: 8px;"
            >
              ${r.clawhubInstallMessage.text}
            </div>`:n}
        ${_(r)}
      </div>

      ${r.error?i`<div class="callout danger" style="margin-top: 12px;">${r.error}</div>`:n}
      ${u.length===0?i`
            <div class="muted" style="margin-top: 16px">
              ${!r.connected&&!r.report?`Not connected to gateway.`:`No skills found.`}
            </div>
          `:i`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${d.map(e=>i`
                  <details class="agent-skills-group" open>
                    <summary class="agent-skills-header">
                      <span>${e.label}</span>
                      <span class="muted">${e.skills.length}</span>
                    </summary>
                    <div class="list skills-grid">
                      ${e.skills.map(e=>y(e,r))}
                    </div>
                  </details>
                `)}
            </div>
          `}
    </section>

    ${f?b(f,r):n}
    ${r.clawhubDetailSlug?v(r):n}
  `}function _(e){let t=e.clawhubResults;return t?t.length===0?i`<div class="muted" style="margin-top: 8px;">No skills found on ClawHub.</div>`:i`
    <div class="list" style="margin-top: 8px;">
      ${t.map(t=>i`
          <div
            class="list-item list-item-clickable"
            @click=${()=>e.onClawHubDetailOpen(t.slug)}
          >
            <div class="list-main">
              <div class="list-title">${t.displayName}</div>
              <div class="list-sub">${t.summary?o(t.summary,120):t.slug}</div>
            </div>
            <div class="list-meta" style="display: flex; align-items: center; gap: 8px;">
              ${t.version?i`<span class="muted" style="font-size: 12px;">v${t.version}</span>`:n}
              <button
                class="btn btn--sm"
                ?disabled=${e.clawhubInstallSlug!==null}
                @click=${n=>{n.stopPropagation(),e.onClawHubInstall(t.slug)}}
              >
                ${e.clawhubInstallSlug===t.slug?`Installing…`:`Install`}
              </button>
            </div>
          </div>
        `)}
    </div>
  `:n}function v(e){let r=e.clawhubDetail;return i`
    <dialog
      class="md-preview-dialog"
      ${a(f)}
      @click=${e=>{let t=e.currentTarget;e.target===t&&t.close()}}
      @close=${e.onClawHubDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div class="md-preview-dialog__title">
            ${r?.skill?.displayName??e.clawhubDetailSlug}
          </div>
          <button
            class="btn btn--sm"
            @click=${e=>{e.currentTarget.closest(`dialog`)?.close()}}
          >
            Close
          </button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 16px;">
          ${e.clawhubDetailLoading?i`<div class="muted">${t(`common.loading`)}</div>`:e.clawhubDetailError?i`<div class="callout danger">${e.clawhubDetailError}</div>`:r?.skill?i`
                    <div style="font-size: 14px; line-height: 1.5;">
                      ${r.skill.summary??``}
                    </div>
                    ${r.owner?.displayName?i`<div class="muted" style="font-size: 13px;">
                          By
                          ${r.owner.displayName}${r.owner.handle?i` (@${r.owner.handle})`:n}
                        </div>`:n}
                    ${r.latestVersion?i`<div class="muted" style="font-size: 13px;">
                          Latest: v${r.latestVersion.version}
                        </div>`:n}
                    ${r.latestVersion?.changelog?i`<div
                          style="font-size: 13px; border-top: 1px solid var(--border); padding-top: 12px; white-space: pre-wrap;"
                        >
                          ${r.latestVersion.changelog}
                        </div>`:n}
                    ${r.metadata?.os?i`<div class="muted" style="font-size: 12px;">
                          Platforms: ${r.metadata.os.join(`, `)}
                        </div>`:n}
                    <button
                      class="btn primary"
                      ?disabled=${e.clawhubInstallSlug!==null}
                      @click=${()=>{e.clawhubDetailSlug&&e.onClawHubInstall(e.clawhubDetailSlug)}}
                    >
                      ${e.clawhubInstallSlug===e.clawhubDetailSlug?`Installing…`:`Install ${r.skill.displayName}`}
                    </button>
                  `:i`<div class="muted">Skill not found.</div>`}
        </div>
      </div>
    </dialog>
  `}function y(e,t){let r=t.busyKey===e.skillKey;return i`
    <div class="list-item list-item-clickable" @click=${()=>t.onDetailOpen(e.skillKey)}>
      <div class="list-main">
        <div class="list-title" style="display: flex; align-items: center; gap: 8px;">
          <span class="statusDot ${h(e)}"></span>
          ${e.emoji?i`<span>${e.emoji}</span>`:n}
          <span>${e.name}</span>
        </div>
        <div class="list-sub">${o(e.description,140)}</div>
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
            ?disabled=${r}
            @change=${n=>{n.stopPropagation(),t.onToggle(e.skillKey,e.disabled)}}
          />
        </label>
      </div>
    </div>
  `}function b(e,t){let r=t.busyKey===e.skillKey,o=t.edits[e.skillKey]??``,s=t.messages[e.skillKey]??null,p=e.install.length>0&&e.missing.bins.length>0,m=!!(e.bundled&&e.source!==`openclaw-bundled`),g=u(e),_=c(e);return i`
    <dialog
      class="md-preview-dialog"
      ${a(f)}
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
            ${e.emoji?i`<span style="font-size: 18px;">${e.emoji}</span>`:n}
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

          ${g.length>0?i`
                <div
                  class="callout"
                  style="border-color: var(--warn-subtle); background: var(--warn-subtle); color: var(--warn);"
                >
                  <div style="font-weight: 600; margin-bottom: 4px;">Missing requirements</div>
                  <div>${g.join(`, `)}</div>
                </div>
              `:n}
          ${_.length>0?i`
                <div class="muted" style="font-size: 13px;">Reason: ${_.join(`, `)}</div>
              `:n}

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
            ${p?i`<button
                  class="btn"
                  ?disabled=${r}
                  @click=${()=>t.onInstall(e.skillKey,e.name,e.install[0].id)}
                >
                  ${r?`Installing…`:e.install[0].label}
                </button>`:n}
          </div>

          ${s?i`<div class="callout ${s.kind===`error`?`danger`:`success`}">
                ${s.message}
              </div>`:n}
          ${e.primaryEnv?i`
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
                      .value=${o}
                      @input=${n=>t.onEdit(e.skillKey,n.target.value)}
                    />
                  </div>
                  ${(()=>{let t=d(e.homepage);return t?i`<div class="muted" style="font-size: 13px;">
                          Get your key:
                          <a href="${t}" target="_blank" rel="noopener noreferrer"
                            >${e.homepage}</a
                          >
                        </div>`:n})()}
                  <button
                    class="btn primary"
                    ?disabled=${r}
                    @click=${()=>t.onSaveKey(e.skillKey)}
                  >
                    Save key
                  </button>
                </div>
              `:n}

          <div
            style="border-top: 1px solid var(--border); padding-top: 12px; display: grid; gap: 6px; font-size: 12px; color: var(--muted);"
          >
            <div><span style="font-weight: 600;">Source:</span> ${e.source}</div>
            <div style="font-family: var(--mono); word-break: break-all;">${e.filePath}</div>
            ${(()=>{let t=d(e.homepage);return t?i`<div>
                    <a href="${t}" target="_blank" rel="noopener noreferrer"
                      >${e.homepage}</a
                    >
                  </div>`:n})()}
          </div>
        </div>
      </div>
    </dialog>
  `}export{g as renderSkills};
//# sourceMappingURL=skills-BOYwGc-x.js.map