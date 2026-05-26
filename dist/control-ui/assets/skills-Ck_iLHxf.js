import{h as e,o as t,p as n,t as r}from"./string-coerce-B303fUwC.js";import{t as i}from"./format-CMbyKmU8.js";import{p as a,v as o}from"./index-Bsr3gFG6.js";import{i as s,n as c,r as l,t as u}from"./skills-shared-BAgIhWaY.js";function d(e){return e?a(e,window.location.href):null}function f(e){!(e instanceof HTMLDialogElement)||e.open||(e.isConnected?e.showModal():queueMicrotask(()=>{e.isConnected&&!e.open&&e.showModal()}))}var p=[{id:`all`,label:`All`},{id:`ready`,label:`Ready`},{id:`needs-setup`,label:`Needs Setup`},{id:`disabled`,label:`Disabled`}];function m(e,t){switch(t){case`all`:return!0;case`ready`:return!e.disabled&&e.eligible;case`needs-setup`:return!e.disabled&&!e.eligible;case`disabled`:return e.disabled}throw Error(`Unsupported skills status filter`)}function h(e){return e.disabled?`muted`:e.eligible?`ok`:`warn`}function g(i){let a=i.report?.skills??[],o={all:a.length,ready:0,"needs-setup":0,disabled:0};for(let e of a)e.disabled?o.disabled++:e.eligible?o.ready++:o[`needs-setup`]++;let c=i.statusFilter===`all`?a:a.filter(e=>m(e,i.statusFilter)),l=r(i.filter),u=l?c.filter(e=>r([e.name,e.description,e.source].join(` `)).includes(l)):c,d=s(u),f=i.detailKey?a.find(e=>e.skillKey===i.detailKey)??null:null;return e`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Skills</div>
          <div class="card-sub">Installed skills and their status.</div>
        </div>
        <button
          class="btn"
          ?disabled=${i.loading||!i.connected}
          @click=${i.onRefresh}
        >
          ${i.loading?t(`common.loading`):t(`common.refresh`)}
        </button>
      </div>

      <div class="agent-tabs" style="margin-top: 14px;">
        ${p.map(t=>e`
            <button
              class="agent-tab ${i.statusFilter===t.id?`active`:``}"
              @click=${()=>i.onStatusFilterChange(t.id)}
            >
              ${t.label}<span class="agent-tab-count">${o[t.id]}</span>
            </button>
          `)}
      </div>

      <div
        class="filters"
        style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px;"
      >
        <label class="field" style="flex: 1; min-width: 180px;">
          <input
            .value=${i.filter}
            @input=${e=>i.onFilterChange(e.target.value)}
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
              .value=${i.clawhubQuery}
              @input=${e=>i.onClawHubQueryChange(e.target.value)}
              placeholder="Search ClawHub skills…"
              autocomplete="off"
              name="clawhub-search"
            />
          </label>
          ${i.clawhubSearchLoading?e`<span class="muted">Searching…</span>`:n}
        </div>
        ${i.clawhubSearchError?e`<div class="callout danger" style="margin-top: 8px;">
              ${i.clawhubSearchError}
            </div>`:n}
        ${i.clawhubInstallMessage?e`<div
              class="callout ${i.clawhubInstallMessage.kind===`error`?`danger`:`success`}"
              style="margin-top: 8px;"
            >
              ${i.clawhubInstallMessage.text}
            </div>`:n}
        ${_(i)}
      </div>

      ${i.error?e`<div class="callout danger" style="margin-top: 12px;">${i.error}</div>`:n}
      ${u.length===0?e`
            <div class="muted" style="margin-top: 16px">
              ${!i.connected&&!i.report?`Not connected to gateway.`:`No skills found.`}
            </div>
          `:e`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${d.map(t=>e`
                  <details class="agent-skills-group" open>
                    <summary class="agent-skills-header">
                      <span>${t.label}</span>
                      <span class="muted">${t.skills.length}</span>
                    </summary>
                    <div class="list skills-grid">
                      ${t.skills.map(e=>y(e,i))}
                    </div>
                  </details>
                `)}
            </div>
          `}
    </section>

    ${f?b(f,i):n}
    ${i.clawhubDetailSlug?v(i):n}
  `}function _(t){let r=t.clawhubResults;return r?r.length===0?e`<div class="muted" style="margin-top: 8px;">No skills found on ClawHub.</div>`:e`
    <div class="list" style="margin-top: 8px;">
      ${r.map(r=>e`
          <div
            class="list-item list-item-clickable"
            @click=${()=>t.onClawHubDetailOpen(r.slug)}
          >
            <div class="list-main">
              <div class="list-title">${r.displayName}</div>
              <div class="list-sub">${r.summary?i(r.summary,120):r.slug}</div>
            </div>
            <div class="list-meta" style="display: flex; align-items: center; gap: 8px;">
              ${r.version?e`<span class="muted" style="font-size: 12px;">v${r.version}</span>`:n}
              <button
                class="btn btn--sm"
                ?disabled=${t.clawhubInstallSlug!==null}
                @click=${e=>{e.stopPropagation(),t.onClawHubInstall(r.slug)}}
              >
                ${t.clawhubInstallSlug===r.slug?`Installing…`:`Install`}
              </button>
            </div>
          </div>
        `)}
    </div>
  `:n}function v(r){let i=r.clawhubDetail;return e`
    <dialog
      class="md-preview-dialog"
      ${o(f)}
      @click=${e=>{let t=e.currentTarget;e.target===t&&t.close()}}
      @close=${r.onClawHubDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div class="md-preview-dialog__title">
            ${i?.skill?.displayName??r.clawhubDetailSlug}
          </div>
          <button
            class="btn btn--sm"
            @click=${e=>{e.currentTarget.closest(`dialog`)?.close()}}
          >
            Close
          </button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 16px;">
          ${r.clawhubDetailLoading?e`<div class="muted">${t(`common.loading`)}</div>`:r.clawhubDetailError?e`<div class="callout danger">${r.clawhubDetailError}</div>`:i?.skill?e`
                    <div style="font-size: 14px; line-height: 1.5;">
                      ${i.skill.summary??``}
                    </div>
                    ${i.owner?.displayName?e`<div class="muted" style="font-size: 13px;">
                          By
                          ${i.owner.displayName}${i.owner.handle?e` (@${i.owner.handle})`:n}
                        </div>`:n}
                    ${i.latestVersion?e`<div class="muted" style="font-size: 13px;">
                          Latest: v${i.latestVersion.version}
                        </div>`:n}
                    ${i.latestVersion?.changelog?e`<div
                          style="font-size: 13px; border-top: 1px solid var(--border); padding-top: 12px; white-space: pre-wrap;"
                        >
                          ${i.latestVersion.changelog}
                        </div>`:n}
                    ${i.metadata?.os?e`<div class="muted" style="font-size: 12px;">
                          Platforms: ${i.metadata.os.join(`, `)}
                        </div>`:n}
                    <button
                      class="btn primary"
                      ?disabled=${r.clawhubInstallSlug!==null}
                      @click=${()=>{r.clawhubDetailSlug&&r.onClawHubInstall(r.clawhubDetailSlug)}}
                    >
                      ${r.clawhubInstallSlug===r.clawhubDetailSlug?`Installing…`:`Install ${i.skill.displayName}`}
                    </button>
                  `:e`<div class="muted">Skill not found.</div>`}
        </div>
      </div>
    </dialog>
  `}function y(t,r){let a=r.busyKey===t.skillKey;return e`
    <div class="list-item list-item-clickable" @click=${()=>r.onDetailOpen(t.skillKey)}>
      <div class="list-main">
        <div class="list-title" style="display: flex; align-items: center; gap: 8px;">
          <span class="statusDot ${h(t)}"></span>
          ${t.emoji?e`<span>${t.emoji}</span>`:n}
          <span>${t.name}</span>
        </div>
        <div class="list-sub">${i(t.description,140)}</div>
      </div>
      <div
        class="list-meta"
        style="display: flex; align-items: center; justify-content: flex-end; gap: 10px;"
      >
        <label class="skill-toggle-wrap" @click=${e=>e.stopPropagation()}>
          <input
            type="checkbox"
            class="skill-toggle"
            .checked=${!t.disabled}
            ?disabled=${a}
            @change=${e=>{e.stopPropagation(),r.onToggle(t.skillKey,t.disabled)}}
          />
        </label>
      </div>
    </div>
  `}function b(t,r){let i=r.busyKey===t.skillKey,a=r.edits[t.skillKey]??``,s=r.messages[t.skillKey]??null,p=t.install.length>0&&t.missing.bins.length>0,m=!!(t.bundled&&t.source!==`openclaw-bundled`),g=u(t),_=c(t);return e`
    <dialog
      class="md-preview-dialog"
      ${o(f)}
      @click=${e=>{let t=e.currentTarget;e.target===t&&t.close()}}
      @close=${r.onDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div
            class="md-preview-dialog__title"
            style="display: flex; align-items: center; gap: 8px;"
          >
            <span class="statusDot ${h(t)}"></span>
            ${t.emoji?e`<span style="font-size: 18px;">${t.emoji}</span>`:n}
            <span>${t.name}</span>
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
              ${t.description}
            </div>
            ${l({skill:t,showBundledBadge:m})}
          </div>

          ${g.length>0?e`
                <div
                  class="callout"
                  style="border-color: var(--warn-subtle); background: var(--warn-subtle); color: var(--warn);"
                >
                  <div style="font-weight: 600; margin-bottom: 4px;">Missing requirements</div>
                  <div>${g.join(`, `)}</div>
                </div>
              `:n}
          ${_.length>0?e`
                <div class="muted" style="font-size: 13px;">Reason: ${_.join(`, `)}</div>
              `:n}

          <div style="display: flex; align-items: center; gap: 12px;">
            <label class="skill-toggle-wrap">
              <input
                type="checkbox"
                class="skill-toggle"
                .checked=${!t.disabled}
                ?disabled=${i}
                @change=${()=>r.onToggle(t.skillKey,t.disabled)}
              />
            </label>
            <span style="font-size: 13px; font-weight: 500;">
              ${t.disabled?`Disabled`:`Enabled`}
            </span>
            ${p?e`<button
                  class="btn"
                  ?disabled=${i}
                  @click=${()=>r.onInstall(t.skillKey,t.name,t.install[0].id)}
                >
                  ${i?`Installing…`:t.install[0].label}
                </button>`:n}
          </div>

          ${s?e`<div class="callout ${s.kind===`error`?`danger`:`success`}">
                ${s.message}
              </div>`:n}
          ${t.primaryEnv?e`
                <div style="display: grid; gap: 8px;">
                  <div class="field">
                    <span
                      >API key
                      <span class="muted" style="font-weight: normal; font-size: 0.88em;"
                        >(${t.primaryEnv})</span
                      ></span
                    >
                    <input
                      type="password"
                      .value=${a}
                      @input=${e=>r.onEdit(t.skillKey,e.target.value)}
                    />
                  </div>
                  ${(()=>{let r=d(t.homepage);return r?e`<div class="muted" style="font-size: 13px;">
                          Get your key:
                          <a href="${r}" target="_blank" rel="noopener noreferrer"
                            >${t.homepage}</a
                          >
                        </div>`:n})()}
                  <button
                    class="btn primary"
                    ?disabled=${i}
                    @click=${()=>r.onSaveKey(t.skillKey)}
                  >
                    Save key
                  </button>
                </div>
              `:n}

          <div
            style="border-top: 1px solid var(--border); padding-top: 12px; display: grid; gap: 6px; font-size: 12px; color: var(--muted);"
          >
            <div><span style="font-weight: 600;">Source:</span> ${t.source}</div>
            <div style="font-family: var(--mono); word-break: break-all;">${t.filePath}</div>
            ${(()=>{let r=d(t.homepage);return r?e`<div>
                    <a href="${r}" target="_blank" rel="noopener noreferrer"
                      >${t.homepage}</a
                    >
                  </div>`:n})()}
          </div>
        </div>
      </div>
    </dialog>
  `}export{g as renderSkills};
//# sourceMappingURL=skills-Ck_iLHxf.js.map