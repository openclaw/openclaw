package ai.openclaw.app.calls

import ai.openclaw.app.i18n.nativeString
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.CallEnd
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val CallInk = Color(0xFFF1F5FF)
private val CallSecondary = Color(0xFFB1BDD3)
private val CallAccent = Color(0xFFB5CBFF)
private val CallRed = Color(0xFFB92F48)

/** Presentation only: the controller remains the owner of Answer, audio and termination. */
@Composable
internal fun IncomingCallScreen(
  call: IncomingCallState,
  muted: Boolean,
  routes: List<Pair<String, String>>,
  output: String,
  onAnswer: () -> Unit,
  onEnd: () -> Unit,
  onMute: () -> Unit,
  onRoute: (String) -> Unit,
) {
  val ringing = call.status == IncomingCallStatus.Ringing
  val inCall = call.status == IncomingCallStatus.Connecting || call.status == IncomingCallStatus.Active
  var showRoutes by remember(call.invite.callId, inCall) { mutableStateOf(false) }
  val status =
    when (call.status) {
      IncomingCallStatus.Ringing -> nativeString("Incoming call over your private Gateway connection")
      IncomingCallStatus.Connecting -> nativeString("Connecting live voice…")
      IncomingCallStatus.Active -> if (muted) nativeString("Connected · microphone muted") else nativeString("Connected · microphone on")
      IncomingCallStatus.Ended -> nativeString("Call ended")
      IncomingCallStatus.Declined -> nativeString("Call declined")
      IncomingCallStatus.Missed -> nativeString("Missed call")
      IncomingCallStatus.Error -> nativeString("Call failed")
    }

  Box(
    Modifier
      .fillMaxSize()
      .background(
        Brush.verticalGradient(listOf(Color(0xFF192B4D), Color(0xFF0D1628), Color(0xFF080D17))),
      ).safeDrawingPadding(),
    contentAlignment = Alignment.Center,
  ) {
    Column(
      Modifier
        .widthIn(max = 520.dp)
        .fillMaxSize()
        .verticalScroll(rememberScrollState())
        .padding(horizontal = 28.dp, vertical = 24.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      Text(
        nativeString("OPENCLAW · DATA CALL"),
        color = CallSecondary,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 2.sp,
        textAlign = TextAlign.Center,
      )
      Spacer(Modifier.height(48.dp))
      Box(
        Modifier.size(172.dp).background(Brush.radialGradient(listOf(Color(0xFF4768A5).copy(alpha = 0.45f), Color.Transparent)), CircleShape),
        contentAlignment = Alignment.Center,
      ) {
        Box(
          Modifier
            .size(132.dp)
            .border(1.dp, Color(0xFF637CAA).copy(alpha = 0.5f), CircleShape)
            .padding(12.dp)
            .background(Brush.linearGradient(listOf(Color(0xFF375887), Color(0xFF233653))), CircleShape),
          contentAlignment = Alignment.Center,
        ) {
          Icon(Icons.Rounded.GraphicEq, null, Modifier.size(52.dp), tint = CallAccent)
        }
      }
      Spacer(Modifier.height(20.dp))
      // Never render the topic or dossier on this lockscreen-visible surface.
      Text(call.invite.callerName, color = CallInk, fontSize = 34.sp, lineHeight = 40.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
      Spacer(Modifier.height(16.dp))
      Surface(color = if (inCall && muted) Color(0xFF49303A) else Color(0xFF23324B), shape = RoundedCornerShape(24.dp)) {
        Row(Modifier.padding(horizontal = 18.dp, vertical = 12.dp).semantics { liveRegion = LiveRegionMode.Polite }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
          if (inCall) Icon(if (muted) Icons.Rounded.MicOff else Icons.Rounded.Mic, null, Modifier.size(18.dp), tint = if (muted) Color(0xFFFFB9C3) else CallAccent)
          Text(status, color = if (inCall && muted) Color(0xFFFFD9DF) else CallInk, fontSize = 14.sp, textAlign = TextAlign.Center)
        }
      }
      call.detail?.let {
        Text(it, Modifier.padding(top = 14.dp), color = CallSecondary, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
      }
      Spacer(Modifier.height(60.dp))
      if (inCall) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.Top) {
          CallControl(
            label = if (muted) nativeString("Unmute microphone") else nativeString("Mute microphone"),
            icon = if (muted) Icons.Rounded.MicOff else Icons.Rounded.Mic,
            selected = muted,
            onClick = onMute,
            modifier = Modifier.weight(1f),
          )
          CallControl(
            label = nativeString("Audio output"),
            detail = output,
            icon = Icons.AutoMirrored.Rounded.VolumeUp,
            enabled = routes.isNotEmpty(),
            onClick = { showRoutes = true },
            modifier = Modifier.weight(1f),
          )
        }
        Spacer(Modifier.height(36.dp))
      }
      if (ringing) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.Top) {
          CallControl(nativeString("Decline"), Icons.Rounded.CallEnd, onClick = onEnd, color = CallRed, modifier = Modifier.weight(1f))
          CallControl(nativeString("Answer"), Icons.Rounded.Call, onClick = onAnswer, color = Color(0xFF22754F), modifier = Modifier.weight(1f))
        }
      } else {
        Button(
          onClick = onEnd,
          modifier = Modifier.fillMaxWidth().widthIn(max = 360.dp),
          shape = RoundedCornerShape(28.dp),
          colors = ButtonDefaults.buttonColors(containerColor = if (call.status.isTerminal) Color(0xFF28364D) else CallRed, contentColor = Color.White),
        ) {
          Icon(if (call.status.isTerminal) Icons.Rounded.Close else Icons.Rounded.CallEnd, null, Modifier.padding(vertical = 12.dp).size(26.dp))
          Text(if (call.status.isTerminal) nativeString("Close") else nativeString("End call"), Modifier.padding(start = 14.dp), fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        }
      }
      Spacer(Modifier.height(24.dp))
    }
  }
  if (showRoutes && inCall) {
    AlertDialog(
      onDismissRequest = { showRoutes = false },
      title = { Text(nativeString("Audio output")) },
      text = {
        Column {
          routes.forEach { (id, label) ->
            TextButton(onClick = {
              onRoute(id)
              showRoutes = false
            }, modifier = Modifier.fillMaxWidth()) {
              Text(label, Modifier.weight(1f))
              if (label == output) Icon(Icons.Rounded.Check, null)
            }
          }
        }
      },
      confirmButton = { TextButton(onClick = { showRoutes = false }) { Text(nativeString("Close")) } },
    )
  }
}

@Composable
private fun CallControl(
  label: String,
  icon: ImageVector,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  detail: String? = null,
  selected: Boolean = false,
  enabled: Boolean = true,
  color: Color = Color(0xFF283953),
) {
  Column(
    modifier
      .padding(horizontal = 6.dp)
      .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
      .semantics { this.selected = selected }
      .padding(vertical = 8.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Surface(
      modifier = Modifier.size(76.dp),
      shape = CircleShape,
      color = if (selected) CallInk else color,
      contentColor = if (selected) Color(0xFF14223A) else Color.White,
    ) {
      Box(contentAlignment = Alignment.Center) { Icon(icon, null, Modifier.size(30.dp)) }
    }
    Text(label, Modifier.padding(top = 12.dp), color = CallInk, fontSize = 14.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
    detail?.let { Text(it, Modifier.padding(top = 5.dp), color = CallSecondary, fontSize = 13.sp, textAlign = TextAlign.Center) }
  }
}
