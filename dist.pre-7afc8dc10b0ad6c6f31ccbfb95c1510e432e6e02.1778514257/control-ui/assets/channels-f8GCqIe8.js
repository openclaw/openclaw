import{f as e,t as o,H as W,I as B,J as H,A as c,k as u,K as U,L as K}from"./index-x9C_NheI.js";import{a as j,f as V}from"./channel-config-extras-DIqWFin2.js";function Q(t,a){let n=t;for(const s of a){if(!n)return null;const l=H(n);if(l==="object"){const i=n.properties??{};if(typeof s=="string"&&i[s]){n=i[s];continue}const d=n.additionalProperties;if(typeof s=="string"&&d&&typeof d=="object"){n=d;continue}return null}if(l==="array"){if(typeof s!="number")return null;n=(Array.isArray(n.items)?n.items[0]:n.items)??null;continue}return null}return n}function z(t,a){return j(t,a)??{}}const _=["groupPolicy","streamMode","dmPolicy"];function G(t){const a=_.flatMap(n=>n in t?[[n,t[n]]]:[]);return a.length===0?null:e`
    <div class="status-list" style="margin-top: 12px;">
      ${a.map(([n,s])=>e`
          <div>
            <span class="label">${n}</span>
            <span>${V(s)}</span>
          </div>
        `)}
    </div>
  `}function J(t){const a=W(t.schema),n=a.schema;if(!n)return e` <div class="callout danger">Schema unavailable. Use Raw.</div> `;const s=Q(n,["channels",t.channelId]);if(!s)return e` <div class="callout danger">Channel config schema unavailable.</div> `;const l=t.configValue??{},i=z(l,t.channelId);return e`
    <div class="config-form">
      ${B({schema:s,value:i,path:["channels",t.channelId],hints:t.uiHints,unsupported:new Set(a.unsupportedPaths),disabled:t.disabled,showLabel:!1,onPatch:t.onPatch})}
    </div>
    ${G(i)}
  `}function f(t){const{channelId:a,props:n}=t,s=n.configSaving||n.configSchemaLoading;return e`
    <div style="margin-top: 16px;">
      ${n.configSchemaLoading?e` <div class="muted">Loading config schema…</div> `:J({channelId:a,configValue:n.configForm,schema:n.configSchema,uiHints:n.configUiHints,disabled:s,onPatch:n.onConfigPatch})}
      <div class="row" style="margin-top: 12px;">
        <button
          class="btn primary"
          ?disabled=${s||!n.configFormDirty}
          @click=${()=>n.onConfigSave()}
        >
          ${n.configSaving?"Saving…":"Save"}
        </button>
        <button class="btn" ?disabled=${s} @click=${()=>n.onConfigReload()}>
          ${o("common.reload")}
        </button>
      </div>
    </div>
  `}function Y(t,a){return a.snapshot?.channels?.[t]}function q(t,a){const n=a.snapshot?.channelAccounts?.[t]??[],s=a.snapshot?.channelDefaultAccountId?.[t];return(s?n.find(l=>l.accountId===s):void 0)??n[0]??null}function R(t,a){const n=Y(t,a),s=a.snapshot?.channelAccounts?.[t]??[],l=q(t,a),i=typeof n?.configured=="boolean"?n.configured:typeof l?.configured=="boolean"?l.configured:null,d=typeof n?.running=="boolean"?n.running:null,v=typeof n?.connected=="boolean"?n.connected:null,r=s.some(b=>b.configured||b.running||b.connected);return{configured:i,running:d,connected:v,defaultAccount:l,hasAnyActiveAccount:r,status:n}}function X(t,a){if(!a.snapshot)return!1;const n=R(t,a);return n.configured===!0||n.running===!0||n.connected===!0||n.hasAnyActiveAccount}function h(t,a){return R(t,a).configured}function g(t){return t==null?o("common.na"):t?o("common.yes"):o("common.no")}function $(t){return e`
    <div class="card">
      <div class="card-title">${t.title}</div>
      <div class="card-sub">${t.subtitle}</div>
      ${t.accountCountLabel}

      <div class="status-list" style="margin-top: 16px;">
        ${t.statusRows.map(a=>e`
            <div>
              <span class="label">${a.label}</span>
              <span>${a.value}</span>
            </div>
          `)}
      </div>

      ${t.lastError?e`<div class="callout danger" style="margin-top: 12px;">${t.lastError}</div>`:c}
      ${t.secondaryCallout??c} ${t.extraContent??c}
      ${t.configSection} ${t.footer??c}
    </div>
  `}function Z(t,a){return a?.[t]?.length??0}function F(t,a){const n=Z(t,a);return n<2?c:e`<div class="account-count">Accounts (${n})</div>`}function nn(t){const{props:a,discord:n,accountCountLabel:s}=t,l=h("discord",a);return $({title:"Discord",subtitle:"Bot status and channel configuration.",accountCountLabel:s,statusRows:[{label:o("common.configured"),value:g(l)},{label:o("common.running"),value:n?.running?o("common.yes"):o("common.no")},{label:o("common.lastStart"),value:n?.lastStartAt?u(n.lastStartAt):o("common.na")},{label:o("common.lastProbe"),value:n?.lastProbeAt?u(n.lastProbeAt):o("common.na")}],lastError:n?.lastError,secondaryCallout:n?.probe?e`<div class="callout" style="margin-top: 12px;">
          ${n.probe.ok?o("common.probeOk"):o("common.probeFailed")} ·
          ${n.probe.status??""} ${n.probe.error??""}
        </div>`:c,configSection:f({channelId:"discord",props:a}),footer:e`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>a.onRefresh(!0)}>${o("common.probe")}</button>
    </div>`})}function on(t){const{props:a,googleChat:n,accountCountLabel:s}=t,l=h("googlechat",a);return $({title:"Google Chat",subtitle:"Chat API webhook status and channel configuration.",accountCountLabel:s,statusRows:[{label:o("common.configured"),value:g(l)},{label:o("common.running"),value:n?n.running?o("common.yes"):o("common.no"):o("common.na")},{label:o("common.credential"),value:n?.credentialSource??o("common.na")},{label:o("common.audience"),value:n?.audienceType?`${n.audienceType}${n.audience?` · ${n.audience}`:""}`:o("common.na")},{label:o("common.lastStart"),value:n?.lastStartAt?u(n.lastStartAt):o("common.na")},{label:o("common.lastProbe"),value:n?.lastProbeAt?u(n.lastProbeAt):o("common.na")}],lastError:n?.lastError,secondaryCallout:n?.probe?e`<div class="callout" style="margin-top: 12px;">
          ${n.probe.ok?o("common.probeOk"):o("common.probeFailed")} ·
          ${n.probe.status??""} ${n.probe.error??""}
        </div>`:c,configSection:f({channelId:"googlechat",props:a}),footer:e`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>a.onRefresh(!0)}>${o("common.probe")}</button>
    </div>`})}function tn(t){const{props:a,imessage:n,accountCountLabel:s}=t,l=h("imessage",a);return $({title:"iMessage",subtitle:"macOS bridge status and channel configuration.",accountCountLabel:s,statusRows:[{label:o("common.configured"),value:g(l)},{label:o("common.running"),value:n?.running?o("common.yes"):o("common.no")},{label:o("common.lastStart"),value:n?.lastStartAt?u(n.lastStartAt):o("common.na")},{label:o("common.lastProbe"),value:n?.lastProbeAt?u(n.lastProbeAt):o("common.na")}],lastError:n?.lastError,secondaryCallout:n?.probe?e`<div class="callout" style="margin-top: 12px;">
          ${n.probe.ok?o("common.probeOk"):o("common.probeFailed")} ·
          ${n.probe.error??""}
        </div>`:c,configSection:f({channelId:"imessage",props:a}),footer:e`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>a.onRefresh(!0)}>${o("common.probe")}</button>
    </div>`})}function L(t){return t?t.length<=20?t:`${t.slice(0,8)}...${t.slice(-8)}`:o("common.na")}function an(t){const{props:a,nostr:n,nostrAccounts:s,accountCountLabel:l,profileFormState:i,profileFormCallbacks:d,onEditProfile:v}=t,r=s[0],b=n?.configured??r?.configured??!1,w=n?.running??r?.running??!1,y=n?.publicKey??r?.publicKey,P=n?.lastStartAt??r?.lastStartAt??null,x=n?.lastError??r?.lastError??null,p=s.length>1,A=i!=null,M=m=>{const C=m.publicKey,S=m.profile,I=S?.displayName??S?.name??m.name??m.accountId;return e`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">${I}</div>
          <div class="account-card-id">${m.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">${o("common.running")}</span>
            <span>${m.running?o("common.yes"):o("common.no")}</span>
          </div>
          <div>
            <span class="label">${o("common.configured")}</span>
            <span>${m.configured?o("common.yes"):o("common.no")}</span>
          </div>
          <div>
            <span class="label">${o("common.publicKey")}</span>
            <span class="monospace" title="${C??""}">${L(C)}</span>
          </div>
          <div>
            <span class="label">${o("common.lastInbound")}</span>
            <span
              >${m.lastInboundAt?u(m.lastInboundAt):o("common.na")}</span
            >
          </div>
          ${m.lastError?e` <div class="account-card-error">${m.lastError}</div> `:c}
        </div>
      </div>
    `},D=()=>{if(A&&d)return U({state:i,callbacks:d,accountId:s[0]?.accountId??"default"});const m=r?.profile??n?.profile,{name:C,displayName:S,about:I,picture:k,nip05:E}=m??{},O=C||S||I||k||E;return e`
      <div
        style="margin-top: 16px; padding: 12px; background: var(--bg-secondary); border-radius: var(--radius-md);"
      >
        <div
          style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;"
        >
          <div style="font-weight: 500;">${o("channels.nostr.profile")}</div>
          ${b?e`
                <button
                  class="btn btn--sm"
                  @click=${v}
                  style="font-size: 12px; padding: 4px 8px;"
                >
                  ${o("channels.nostr.editProfile")}
                </button>
              `:c}
        </div>
        ${O?e`
              <div class="status-list">
                ${k?e`
                      <div style="margin-bottom: 8px;">
                        <img
                          src=${k}
                          alt=${o("channels.nostr.profilePicture")}
                          style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color);"
                          @error=${T=>{T.target.style.display="none"}}
                        />
                      </div>
                    `:c}
                ${C?e`<div>
                      <span class="label">${o("channels.nostr.name")}</span><span>${C}</span>
                    </div>`:c}
                ${S?e`<div>
                      <span class="label">${o("channels.nostr.displayName")}</span
                      ><span>${S}</span>
                    </div>`:c}
                ${I?e`<div>
                      <span class="label">${o("channels.nostr.about")}</span
                      ><span style="max-width: 300px; overflow: hidden; text-overflow: ellipsis;"
                        >${I}</span
                      >
                    </div>`:c}
                ${E?e`<div><span class="label">NIP-05</span><span>${E}</span></div>`:c}
              </div>
            `:e`
              <div style="color: var(--text-muted); font-size: 13px">
                ${o("channels.nostr.noProfile")} ${o("channels.nostr.noProfileHint")}
              </div>
            `}
      </div>
    `};return e`
    <div class="card">
      <div class="card-title">Nostr</div>
      <div class="card-sub">Decentralized DMs via Nostr relays (NIP-04).</div>
      ${l}
      ${p?e`
            <div class="account-card-list">
              ${s.map(m=>M(m))}
            </div>
          `:e`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">${o("common.configured")}</span>
                <span>${b?o("common.yes"):o("common.no")}</span>
              </div>
              <div>
                <span class="label">${o("common.running")}</span>
                <span>${w?o("common.yes"):o("common.no")}</span>
              </div>
              <div>
                <span class="label">${o("common.publicKey")}</span>
                <span class="monospace" title="${y??""}"
                  >${L(y)}</span
                >
              </div>
              <div>
                <span class="label">${o("common.lastStart")}</span>
                <span>
                  ${P?u(P):o("common.na")}
                </span>
              </div>
            </div>
          `}
      ${x?e`<div class="callout danger" style="margin-top: 12px;">${x}</div>`:c}
      ${D()} ${f({channelId:"nostr",props:a})}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${()=>a.onRefresh(!1)}>${o("common.refresh")}</button>
      </div>
    </div>
  `}function en(t){const{props:a,signal:n,accountCountLabel:s}=t,l=h("signal",a);return $({title:"Signal",subtitle:"signal-cli status and channel configuration.",accountCountLabel:s,statusRows:[{label:o("common.configured"),value:g(l)},{label:o("common.running"),value:n?.running?o("common.yes"):o("common.no")},{label:o("common.baseUrl"),value:n?.baseUrl??o("common.na")},{label:o("common.lastStart"),value:n?.lastStartAt?u(n.lastStartAt):o("common.na")},{label:o("common.lastProbe"),value:n?.lastProbeAt?u(n.lastProbeAt):o("common.na")}],lastError:n?.lastError,secondaryCallout:n?.probe?e`<div class="callout" style="margin-top: 12px;">
          ${n.probe.ok?o("common.probeOk"):o("common.probeFailed")} ·
          ${n.probe.status??""} ${n.probe.error??""}
        </div>`:c,configSection:f({channelId:"signal",props:a}),footer:e`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>a.onRefresh(!0)}>${o("common.probe")}</button>
    </div>`})}function sn(t){const{props:a,slack:n,accountCountLabel:s}=t,l=h("slack",a);return $({title:"Slack",subtitle:"Socket mode status and channel configuration.",accountCountLabel:s,statusRows:[{label:o("common.configured"),value:g(l)},{label:o("common.running"),value:n?.running?o("common.yes"):o("common.no")},{label:o("common.lastStart"),value:n?.lastStartAt?u(n.lastStartAt):o("common.na")},{label:o("common.lastProbe"),value:n?.lastProbeAt?u(n.lastProbeAt):o("common.na")}],lastError:n?.lastError,secondaryCallout:n?.probe?e`<div class="callout" style="margin-top: 12px;">
          ${n.probe.ok?o("common.probeOk"):o("common.probeFailed")} ·
          ${n.probe.status??""} ${n.probe.error??""}
        </div>`:c,configSection:f({channelId:"slack",props:a}),footer:e`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>a.onRefresh(!0)}>${o("common.probe")}</button>
    </div>`})}function ln(t){const{props:a,telegram:n,telegramAccounts:s,accountCountLabel:l}=t,i=s.length>1,d=h("telegram",a),v=r=>{const w=r.probe?.bot?.username,y=r.name||r.accountId;return e`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">${w?`@${w}`:y}</div>
          <div class="account-card-id">${r.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">${o("common.running")}</span>
            <span>${r.running?o("common.yes"):o("common.no")}</span>
          </div>
          <div>
            <span class="label">${o("common.configured")}</span>
            <span>${r.configured?o("common.yes"):o("common.no")}</span>
          </div>
          <div>
            <span class="label">${o("common.lastInbound")}</span>
            <span
              >${r.lastInboundAt?u(r.lastInboundAt):o("common.na")}</span
            >
          </div>
          ${r.lastError?e` <div class="account-card-error">${r.lastError}</div> `:c}
        </div>
      </div>
    `};return i?e`
      <div class="card">
        <div class="card-title">Telegram</div>
        <div class="card-sub">Bot status and channel configuration.</div>
        ${l}

        <div class="account-card-list">
          ${s.map(r=>v(r))}
        </div>

        ${n?.lastError?e`<div class="callout danger" style="margin-top: 12px;">${n.lastError}</div>`:c}
        ${n?.probe?e`<div class="callout" style="margin-top: 12px;">
              ${n.probe.ok?o("common.probeOk"):o("common.probeFailed")} ·
              ${n.probe.status??""} ${n.probe.error??""}
            </div>`:c}
        ${f({channelId:"telegram",props:a})}

        <div class="row" style="margin-top: 12px;">
          <button class="btn" @click=${()=>a.onRefresh(!0)}>${o("common.probe")}</button>
        </div>
      </div>
    `:$({title:"Telegram",subtitle:"Bot status and channel configuration.",accountCountLabel:l,statusRows:[{label:o("common.configured"),value:g(d)},{label:o("common.running"),value:n?.running?o("common.yes"):o("common.no")},{label:o("common.mode"),value:n?.mode??o("common.na")},{label:o("common.lastStart"),value:n?.lastStartAt?u(n.lastStartAt):o("common.na")},{label:o("common.lastProbe"),value:n?.lastProbeAt?u(n.lastProbeAt):o("common.na")}],lastError:n?.lastError,secondaryCallout:n?.probe?e`<div class="callout" style="margin-top: 12px;">
          ${n.probe.ok?o("common.probeOk"):o("common.probeFailed")} ·
          ${n.probe.status??""} ${n.probe.error??""}
        </div>`:c,configSection:f({channelId:"telegram",props:a}),footer:e`<div class="row" style="margin-top: 12px;">
      <button class="btn" @click=${()=>a.onRefresh(!0)}>${o("common.probe")}</button>
    </div>`})}function cn(t){const{props:a,whatsapp:n,accountCountLabel:s}=t,l=h("whatsapp",a),i=n?.linked===!0,d=a.whatsappQrDataUrl!=null;return $({title:"WhatsApp",subtitle:"Link WhatsApp Web and monitor connection health.",accountCountLabel:s,statusRows:[{label:o("common.configured"),value:g(l)},{label:o("common.linked"),value:n?.linked?o("common.yes"):o("common.no")},{label:o("common.running"),value:n?.running?o("common.yes"):o("common.no")},{label:o("common.connected"),value:n?.connected?o("common.yes"):o("common.no")},{label:o("common.lastConnect"),value:n?.lastConnectedAt?u(n.lastConnectedAt):o("common.na")},{label:o("common.lastMessage"),value:n?.lastMessageAt?u(n.lastMessageAt):o("common.na")},{label:o("common.authAge"),value:n?.authAgeMs!=null?K(n.authAgeMs):o("common.na")}],lastError:n?.lastError,extraContent:e`
      ${a.whatsappMessage?e`<div class="callout" style="margin-top: 12px;">${a.whatsappMessage}</div>`:c}
      ${a.whatsappQrDataUrl?e`<div class="qr-wrap">
            <img src=${a.whatsappQrDataUrl} alt="WhatsApp QR" />
          </div>`:c}
    `,configSection:f({channelId:"whatsapp",props:a}),footer:e`<div class="row" style="margin-top: 14px; flex-wrap: wrap;">
      ${i?e`<button
            class="btn"
            ?disabled=${a.whatsappBusy}
            @click=${()=>a.onWhatsAppStart(!0)}
          >
            ${o("common.relink")}
          </button>`:e`<button
            class="btn primary"
            ?disabled=${a.whatsappBusy}
            @click=${()=>a.onWhatsAppStart(!1)}
          >
            ${a.whatsappBusy?o("common.working"):o("common.showQr")}
          </button>`}
      ${d?e`<button
            class="btn"
            ?disabled=${a.whatsappBusy}
            @click=${()=>a.onWhatsAppWait()}
          >
            ${o("common.waitForScan")}
          </button>`:c}
      <button
        class="btn danger"
        ?disabled=${a.whatsappBusy}
        @click=${()=>a.onWhatsAppLogout()}
      >
        ${o("common.logout")}
      </button>
      <button class="btn" @click=${()=>a.onRefresh(!0)}>${o("common.refresh")}</button>
    </div>`})}function yn(t){const a=t.snapshot?.channels,n=a?.whatsapp??void 0,s=a?.telegram??void 0,l=a?.discord??null,i=a?.googlechat??null,d=a?.slack??null,v=a?.signal??null,r=a?.imessage??null,b=a?.nostr??null,y=rn(t.snapshot).map((p,A)=>({key:p,enabled:X(p,t),order:A})).toSorted((p,A)=>p.enabled!==A.enabled?p.enabled?-1:1:p.order-A.order),P=!!(t.loading&&t.snapshot&&t.lastSuccessAt),x=t.snapshot?.warnings?.filter(p=>p.trim())??[];return e`
    <section class="grid grid-cols-2">
      ${y.map(p=>dn(p.key,t,{whatsapp:n,telegram:s,discord:l,googlechat:i,slack:d,signal:v,imessage:r,nostr:b,channelAccounts:t.snapshot?.channelAccounts??null}))}
    </section>

    <section class="card" style="margin-top: 18px;">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">${o("channels.health.title")}</div>
          <div class="card-sub">${o("channels.health.subtitle")}</div>
        </div>
        <div class="muted">
          ${t.lastSuccessAt?u(t.lastSuccessAt):o("common.na")}
        </div>
      </div>
      ${P?e`
            <div class="callout info" style="margin-top: 12px;">
              Refreshing channel status in the background; showing the last successful snapshot.
            </div>
          `:c}
      ${t.snapshot?.partial?e`
            <div class="callout warn" style="margin-top: 12px;">
              Some channel checks did not finish before the UI budget.
              ${x.length>0?x.slice(0,3).join("; "):""}
            </div>
          `:c}
      ${t.lastError?e`<div class="callout danger" style="margin-top: 12px;">${t.lastError}</div>`:c}
      <pre class="code-block" style="margin-top: 12px;">
${t.snapshot?JSON.stringify(t.snapshot,null,2):o("channels.health.noSnapshotYet")}
      </pre
      >
    </section>
  `}function rn(t){return t?.channelMeta?.length?t.channelMeta.map(a=>a.id):t?.channelOrder?.length?t.channelOrder:["whatsapp","telegram","discord","googlechat","slack","signal","imessage","nostr"]}function dn(t,a,n){const s=F(t,n.channelAccounts);switch(t){case"whatsapp":return cn({props:a,whatsapp:n.whatsapp,accountCountLabel:s});case"telegram":return ln({props:a,telegram:n.telegram,telegramAccounts:n.channelAccounts?.telegram??[],accountCountLabel:s});case"discord":return nn({props:a,discord:n.discord,accountCountLabel:s});case"googlechat":return on({props:a,googleChat:n.googlechat,accountCountLabel:s});case"slack":return sn({props:a,slack:n.slack,accountCountLabel:s});case"signal":return en({props:a,signal:n.signal,accountCountLabel:s});case"imessage":return tn({props:a,imessage:n.imessage,accountCountLabel:s});case"nostr":{const l=n.channelAccounts?.nostr??[],i=l[0],d=i?.accountId??"default",v=i?.profile??null,r=a.nostrProfileAccountId===d?a.nostrProfileFormState:null,b=r?{onFieldChange:a.onNostrProfileFieldChange,onSave:a.onNostrProfileSave,onImport:a.onNostrProfileImport,onCancel:a.onNostrProfileCancel,onToggleAdvanced:a.onNostrProfileToggleAdvanced}:null;return an({props:a,nostr:n.nostr,nostrAccounts:l,accountCountLabel:s,profileFormState:r,profileFormCallbacks:b,onEditProfile:()=>a.onNostrProfileEdit(d,v)})}default:return un(t,a,n.channelAccounts??{})}}function un(t,a,n){const s=pn(a.snapshot,t),l=R(t,a),i=typeof l.status?.lastError=="string"?l.status.lastError:void 0,d=n[t]??[],v=F(t,n);return e`
    <div class="card">
      <div class="card-title">${s}</div>
      <div class="card-sub">${o("channels.generic.subtitle")}</div>
      ${v}
      ${d.length>0?e`
            <div class="account-card-list">
              ${d.map(r=>fn(r))}
            </div>
          `:e`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">${o("common.configured")}</span>
                <span>${g(l.configured)}</span>
              </div>
              <div>
                <span class="label">${o("common.running")}</span>
                <span>${g(l.running)}</span>
              </div>
              <div>
                <span class="label">${o("common.connected")}</span>
                <span>${g(l.connected)}</span>
              </div>
            </div>
          `}
      ${i?e`<div class="callout danger" style="margin-top: 12px;">${i}</div>`:c}
      ${f({channelId:t,props:a})}
    </div>
  `}function mn(t){return t?.channelMeta?.length?Object.fromEntries(t.channelMeta.map(a=>[a.id,a])):{}}function pn(t,a){return mn(t)[a]?.label??t?.channelLabels?.[a]??a}const vn=600*1e3;function N(t){return t.lastInboundAt?Date.now()-t.lastInboundAt<vn:!1}function bn(t){return t.running?o("common.yes"):N(t)?o("common.active"):o("common.no")}function gn(t){return t.connected===!0?o("common.yes"):t.connected===!1?o("common.no"):N(t)?o("common.active"):o("common.na")}function fn(t){const a=bn(t),n=gn(t);return e`
    <div class="account-card">
      <div class="account-card-header">
        <div class="account-card-title">${t.name||t.accountId}</div>
        <div class="account-card-id">${t.accountId}</div>
      </div>
      <div class="status-list account-card-status">
        <div>
          <span class="label">${o("common.running")}</span>
          <span>${a}</span>
        </div>
        <div>
          <span class="label">${o("common.configured")}</span>
          <span>${t.configured?o("common.yes"):o("common.no")}</span>
        </div>
        <div>
          <span class="label">${o("common.connected")}</span>
          <span>${n}</span>
        </div>
        <div>
          <span class="label">${o("common.lastInbound")}</span>
          <span
            >${t.lastInboundAt?u(t.lastInboundAt):o("common.na")}</span
          >
        </div>
        ${t.lastError?e` <div class="account-card-error">${t.lastError}</div> `:c}
      </div>
    </div>
  `}export{yn as renderChannels};
//# sourceMappingURL=channels-f8GCqIe8.js.map
