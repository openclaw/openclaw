import QtQuick
import QtQuick.Controls as Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

Panel {
  id: root
  moduleName: "openclaw.desktop"
  ipcTarget: "openclaw.desktop"

  readonly property var service: bar && bar.shell ? bar.shell.serviceFor("openclaw.desktop") : null
  property var registeredService: null
  property bool mounted: false
  readonly property var agents: service ? service.snapshot.agents || [] : []
  readonly property var sessions: service ? service.snapshot.sessions || [] : []
  readonly property string defaultAgent: service ? service.snapshot.defaultAgent || "" : ""
  readonly property bool selectionRequired: !service || service.snapshot.selectionRequired !== false
  property string agentFilter: ""
  property string stateFilter: "all"
  property string selectedId: ""
  readonly property string connectionError: service ? service.error : "Connecting to OpenClaw…"
  readonly property bool connected: !!service && service.ready && service.snapshot.ok === true
  property bool hidePreviews: false
  readonly property bool hasMore: !!service && service.snapshot.hasMore === true
  readonly property double checkedAt: service ? service.snapshot.checkedAt || 0 : 0
  readonly property string routeId: service ? service.routeId : ""
  property string acceptedRoute: ""
  property bool routeChanged: false
  property string sendNotice: ""
  property bool uncertain: false
  property string sendId: ""
  property string activationId: ""
  property var sendRequest: ({})
  readonly property bool sending: sendId !== ""
  readonly property bool yielded: !!service && service.yielded
  readonly property var selectedSession: sessions.find(function(s) { return s.id === root.selectedId }) || null
  readonly property string targetAgent: selectedId ? (selectedSession ? selectedSession.agentId : "") : (agentFilter || (selectionRequired ? "" : defaultAgent))
  readonly property bool canSend: connected && !routeChanged && !sending && !uncertain && targetAgent !== "" && prompt.text.trim() !== "" && prompt.text.length <= 8000
    && (!selectedId || selectedSession !== null)
  readonly property int busyCount: sessions.filter(function(s) { return s.status === "running" || s.status === "queued" }).length
  readonly property int attentionCount: sessions.filter(function(s) { return s.attention }).length
  readonly property var agentOptions: [{value: "", label: "All agents (" + agents.length + ")"}].concat(agents.map(function(a) {
    var count = root.sessions.filter(function(s) { return s.agentId === a.id }).length
    return {value: a.id, label: a.name + " · " + count + " sessions"}
  }))
  readonly property var visibleSessions: sessions.filter(function(s) {
    var matchesAgent = !root.agentFilter || s.agentId === root.agentFilter
    var matchesState = root.stateFilter === "all" || (root.stateFilter === "busy" ? ["running", "queued"].indexOf(s.status) >= 0 : s.attention)
    var query = search.text.toLowerCase()
    return matchesAgent && matchesState && (!query || (s.title + " " + s.agentId + " " + s.model).toLowerCase().indexOf(query) >= 0)
  })
  readonly property string destination: selectedId
    ? (selectedSession ? (hidePreviews ? "Selected session" : selectedSession.title) : "Selected session unavailable — select it again")
    : "New session · " + agentName(targetAgent)

  visible: !yielded
  implicitWidth: yielded ? 0 : button.implicitWidth
  implicitHeight: yielded ? 0 : button.implicitHeight

  component Copy: Text {
    textFormat: Text.PlainText
    color: Color.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.body
    wrapMode: Text.WordWrap
  }

  function agentName(id) {
    var agent = agents.find(function(a) { return a.id === id })
    return agent ? agent.name : (id || "choose an agent")
  }
  function age(timestamp) {
    if (!timestamp) return ""
    var minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
    if (minutes < 1) return "just now"
    if (minutes < 60) return minutes + "m ago"
    if (minutes < 1440) return Math.floor(minutes / 60) + "h ago"
    return Math.floor(minutes / 1440) + "d ago"
  }
  function bindService() {
    if (!mounted || registeredService === service) return
    if (registeredService) registeredService.unregisterWidget(root)
    registeredService = service
    if (registeredService) registeredService.registerWidget(root)
  }
  onServiceChanged: bindService()
  Component.onCompleted: { mounted = true; bindService() }
  Component.onDestruction: if (registeredService) registeredService.unregisterWidget(root)
  onRouteIdChanged: {
    if (routeId === acceptedRoute) return
    selectedId = ""
    agentFilter = ""
    // A draft belongs to the route the user saw; a new owner cannot inherit it.
    if (prompt.text !== "" || sending) routeChanged = true
    else { acceptedRoute = routeId; routeChanged = false }
  }
  onYieldedChanged: if (yielded) close()
  function refresh() { if (service) service.refresh() }
  function open() { if (!yielded) { refresh(); controller.show() } }
  function activate(action) {
    if (!service || routeChanged || activationId) return
    activationId = service.request({op: "activate", routeId: routeId, action: action,
      sessionKey: selectedSession ? selectedSession.key : "", agentId: targetAgent})
  }
  function openSelected() { if (selectedSession) activate("session") }
  function sendPrompt() {
    if (!canSend) return
    sendRequest = {op: "send", routeId: routeId, agentId: targetAgent, sessionKey: selectedSession ? selectedSession.key : "", message: prompt.text}
    sendId = service.request(sendRequest)
    if (sendId) sendNotice = "Sending to " + destination + "…"
  }
  Connections {
    target: root.service
    function onResult(result) {
      if (result.op === "activate") {
        if (result.id !== root.activationId) return
        root.activationId = ""
        if (result.ok) root.close()
        else root.sendNotice = result.error || "Could not open OpenClaw."
        return
      }
      if (result.id !== root.sendId || result.op !== "send") return
      root.sendId = ""
      root.uncertain = result.uncertain === true
      if (result.routeId === root.routeId && result.sessionId) root.selectedId = result.sessionId
      if (result.ok) {
        root.sendNotice = "Prompt accepted. The session list will show its progress and latest reply."
        if (prompt.text === root.sendRequest.message && result.routeId === root.routeId) prompt.text = ""
      } else root.sendNotice = result.error || "Prompt was not accepted."
      root.sendRequest = ({})
      root.refresh()
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    iconComponent: Component {
      CritterIcon {
        foreground: root.barForeground
        working: root.connected && root.busyCount > 0
      }
    }
    tooltipText: "OpenClaw · " + (root.connected
      ? root.agents.length + " agents · " + root.busyCount + " active · " + root.attentionCount + " need attention"
      : root.connectionError)
    onPressed: function(code) {
      if (code === Qt.MiddleButton) root.refresh()
      else root.toggle()
    }
    Text {
      visible: root.connected && root.attentionCount > 0
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      text: root.attentionCount > 9 ? "+" : root.attentionCount
      textFormat: Text.PlainText
      color: root.barForeground
      font.family: Style.font.family
      font.pixelSize: Style.space(9)
      font.bold: true
    }
  }

  KeyboardPanel {
    id: popup
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: content
    contentWidth: popup.fittedContentWidth(Style.space(480))
    contentHeight: popup.fittedContentHeight(content.implicitHeight, Style.space(760))

    Flickable {
      anchors.fill: parent
      contentWidth: width
      contentHeight: content.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      Controls.ScrollBar.vertical: Controls.ScrollBar {}
      Column {
        id: content
        width: parent.width
        spacing: Style.space(10)
        focus: true
        Keys.onEscapePressed: root.close()
        Keys.onPressed: function(event) {
          if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_L) {
            prompt.forceActiveFocus()
            event.accepted = true
          } else if ((event.modifiers & Qt.ControlModifier) && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter)) {
            root.sendPrompt()
            event.accepted = true
          }
        }
        Row {
          width: parent.width
          spacing: Style.space(12)
          CritterIcon {
            width: Style.space(25); height: width
            foreground: Color.foreground
            animated: false
          }
          Copy { text: "OpenClaw"; font.pixelSize: Style.font.title; font.bold: true }
          Button { text: root.hidePreviews ? "Show previews" : "Hide previews"; focusable: true; onClicked: root.hidePreviews = !root.hidePreviews }
        }
        Copy {
          width: parent.width
          text: root.connected ? root.agents.length + " agents · " + root.sessions.length + " sessions · " + root.busyCount + " active · " + root.attentionCount + " attention" : root.connectionError
        }
        Copy {
          visible: !root.connected && root.checkedAt > 0
          width: parent.width
          text: "Showing cached data from " + root.age(root.checkedAt) + ". Sending is disabled."
          opacity: 0.65
        }
        Copy {
          width: parent.width
          text: service && service.desktop ? "Using the desktop app’s selected Gateway" : "Using the local CLI’s Gateway"
          opacity: 0.65
        }
        Copy {
          width: parent.width
          visible: root.routeChanged
          text: "The Gateway changed. Your draft is saved. Choose whether to use this Gateway before sending."
        }
        Button {
          visible: root.routeChanged
          text: "Use this Gateway"
          enabled: root.routeId !== "" && !root.sending
          focusable: true
          onClicked: { root.acceptedRoute = root.routeId; root.routeChanged = false; root.refresh() }
        }
        Flow {
          width: parent.width
          spacing: Style.space(6)
          Button { text: "Dashboard"; enabled: !root.routeChanged; focusable: true; onClicked: root.activate("dashboard") }
          Button { text: "Quick Chat"; visible: !!root.service && root.service.desktop; enabled: !root.routeChanged; focusable: true; onClicked: root.activate("quickchat") }
          Button { text: "Updates"; visible: !!root.service && root.service.desktop; enabled: !root.routeChanged; focusable: true; onClicked: root.activate("updates") }
          Button { text: "Quit app"; visible: !!root.service && root.service.desktop; enabled: !root.routeChanged; focusable: true; onClicked: root.activate("quit") }
          Button { text: "Diagnostics"; visible: !root.service || !root.service.desktop; enabled: !root.routeChanged; focusable: true; onClicked: root.activate("diagnostics") }
          Button { text: service && service.refreshing ? "Refreshing…" : "Refresh"; enabled: !!service && !service.refreshing; focusable: true; onClicked: root.refresh() }
        }
        Dropdown {
          id: agentPicker
          width: parent.width
          options: root.agentOptions
          value: root.agentFilter
          showLabel: false
          enabled: !root.sending
          onChanged: function(value) { root.agentFilter = value; root.selectedId = "" }
        }
        Row {
          spacing: Style.space(6)
          Repeater {
            model: [{id: "all", name: "All"}, {id: "busy", name: "Active"}, {id: "attention", name: "Attention"}]
            Button {
              required property var modelData
              text: modelData.name
              selected: root.stateFilter === modelData.id
              focusable: true
              onClicked: root.stateFilter = modelData.id
            }
          }
          Button { text: "New session"; enabled: !root.sending; focusable: true; onClicked: root.selectedId = "" }
        }
        TextField {
          id: search
          width: parent.width
          placeholderText: "Find a session, agent, or model…"
          maximumLength: 200
        }
        ListView {
          id: sessionList
          width: parent.width
          height: Style.space(220)
          clip: true
          spacing: Style.space(6)
          model: root.visibleSessions
          boundsBehavior: Flickable.StopAtBounds
          Controls.ScrollBar.vertical: Controls.ScrollBar {}
          delegate: Rectangle {
            id: card
            required property var modelData
            width: sessionList.width
            height: summary.implicitHeight + Style.space(18)
            color: root.selectedId === modelData.id ? Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.10) : "transparent"
            border.color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, root.selectedId === modelData.id ? 0.65 : 0.15)
            radius: Style.cornerRadius
            activeFocusOnTab: true
            Keys.onReturnPressed: if (!root.sending) root.selectedId = modelData.id
            Column {
              id: summary
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.top: parent.top
              anchors.margins: Style.space(9)
              spacing: Style.space(3)
              Copy {
                width: parent.width
                text: (card.modelData.unread ? "● " : "") + (root.hidePreviews ? "Session" : card.modelData.title)
                font.bold: true
                maximumLineCount: 1
                elide: Text.ElideRight
              }
              Copy {
                width: parent.width
                text: root.agentName(card.modelData.agentId) + " · " + (card.modelData.waiting ? "waiting for you" : card.modelData.status) + " · " + root.age(card.modelData.updatedAt)
                opacity: 0.7
                maximumLineCount: 1
                elide: Text.ElideRight
              }
              Copy {
                width: parent.width
                visible: !root.hidePreviews && text !== ""
                text: card.modelData.activity || card.modelData.preview
                maximumLineCount: 2
                elide: Text.ElideRight
                opacity: 0.8
              }
              Copy {
                width: parent.width
                visible: text !== ""
                text: [card.modelData.model, card.modelData.channel, card.modelData.totalTokens ? Math.round(card.modelData.totalTokens / 1000) + "k tokens" : ""].filter(Boolean).join(" · ")
                font.pixelSize: Style.font.caption
                maximumLineCount: 1
                elide: Text.ElideRight
                opacity: 0.55
              }
            }
            MouseArea {
              anchors.fill: parent
              enabled: !root.sending
              cursorShape: Qt.PointingHandCursor
              onClicked: { root.selectedId = card.modelData.id; card.forceActiveFocus() }
              onDoubleClicked: { root.selectedId = card.modelData.id; root.openSelected() }
            }
          }
          Copy {
            anchors.centerIn: parent
            width: parent.width - Style.space(16)
            horizontalAlignment: Text.AlignHCenter
            visible: root.visibleSessions.length === 0
            text: root.connected ? "No matching sessions. Start one below." : "Connect OpenClaw to see your agents and sessions."
            opacity: 0.6
          }
        }
        Copy {
          visible: root.hasMore
          text: "Showing recent and active sessions. Open the dashboard for the full history."
          width: parent.width
          font.pixelSize: Style.font.caption
          opacity: 0.6
        }
        Copy { text: "QUICK PROMPT"; font.pixelSize: Style.font.caption; font.bold: true }
        Copy { width: parent.width; text: "To: " + root.destination; maximumLineCount: 2; elide: Text.ElideRight }
        Controls.TextArea {
          id: prompt
          width: parent.width
          height: Style.space(80)
          placeholderText: "What should your agent do?"
          color: Color.foreground
          placeholderTextColor: Qt.darker(Color.foreground, 1.5)
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          wrapMode: TextEdit.Wrap
          selectByMouse: true
          textFormat: TextEdit.PlainText
          background: Rectangle { color: "transparent"; border.color: Qt.rgba(Color.foreground.r, Color.foreground.g, Color.foreground.b, 0.4); radius: Style.cornerRadius }
        }
        Row {
          spacing: Style.space(6)
          Button { text: root.sending ? "Sending…" : "Send · Ctrl+Enter"; enabled: root.canSend && prompt.text.length <= 8000; focusable: true; onClicked: root.sendPrompt() }
          Button { text: "Open session"; enabled: !!root.selectedSession && !root.routeChanged; focusable: true; onClicked: root.openSelected() }
        }
        Copy { width: parent.width; visible: root.sendNotice !== ""; text: root.sendNotice; opacity: 0.8 }
        Button { visible: root.uncertain; text: "I checked the session — allow sending"; focusable: true; onClicked: { root.uncertain = false; root.sendNotice = "" } }
      }
    }
  }
}
