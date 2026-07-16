package ai.openclaw.wear

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      OpenClawWearApp(
        client = remember { WearStatusClient(applicationContext) },
      )
    }
  }
}

@Composable
internal fun OpenClawWearApp(client: WearStatusClient) {
  var state by remember { mutableStateOf<WearStatusUiState>(WearStatusUiState.Loading) }
  val scope = rememberCoroutineScope()

  LaunchedEffect(client) {
    state = client.loadStatus()
  }

  MaterialTheme {
    AppScaffold {
      WearStatusScreen(
        state = state,
        onRefresh = {
          if (state !is WearStatusUiState.Loading) {
            state = WearStatusUiState.Loading
            scope.launch {
              state = client.loadStatus()
            }
          }
        },
      )
    }
  }
}

@Composable
private fun WearStatusScreen(
  state: WearStatusUiState,
  onRefresh: () -> Unit,
) {
  val listState = rememberTransformingLazyColumnState()
  ScreenScaffold(scrollState = listState) { contentPadding ->
    TransformingLazyColumn(
      modifier = Modifier.background(OpenClawBackground),
      state = listState,
      contentPadding = contentPadding,
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      item {
        Text(
          text = stringResource(R.string.app_name).uppercase(),
          color = OpenClawRed,
          fontSize = 15.sp,
          fontWeight = FontWeight.Bold,
          letterSpacing = 1.2.sp,
          textAlign = TextAlign.Center,
          modifier = Modifier.fillMaxWidth(),
        )
      }
      item {
        StatusPanel(state = state)
      }
      item {
        Button(
          onClick = onRefresh,
          enabled = state !is WearStatusUiState.Loading,
          colors =
            ButtonDefaults.buttonColors(
              containerColor = OpenClawRed,
              contentColor = Color.White,
            ),
          label = {
            Text(
              text = stringResource(R.string.refresh),
              modifier = Modifier.fillMaxWidth(),
              textAlign = TextAlign.Center,
            )
          },
          modifier = Modifier.fillMaxWidth(),
        )
      }
    }
  }
}

@Composable
private fun StatusPanel(state: WearStatusUiState) {
  val presentation = statusPresentation(state)
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .background(OpenClawPanel, RoundedCornerShape(22.dp))
        .padding(horizontal = 14.dp, vertical = 13.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Row(
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.Center,
    ) {
      Box(
        modifier =
          Modifier
            .size(8.dp)
            .background(presentation.indicatorColor, CircleShape),
      )
      Spacer(modifier = Modifier.size(7.dp))
      Text(
        text = stringResource(presentation.titleRes),
        color = Color.White,
        fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
      )
    }
    Spacer(modifier = Modifier.height(6.dp))
    Text(
      text = stringResource(presentation.detailRes),
      color = OpenClawMuted,
      fontSize = 12.sp,
      lineHeight = 15.sp,
      textAlign = TextAlign.Center,
    )
  }
}

private data class StatusPresentation(
  val titleRes: Int,
  val detailRes: Int,
  val indicatorColor: Color,
)

@Composable
private fun statusPresentation(state: WearStatusUiState): StatusPresentation =
  when (state) {
    WearStatusUiState.Loading ->
      StatusPresentation(
        titleRes = R.string.checking_phone,
        detailRes = R.string.reading_status,
        indicatorColor = OpenClawCyan,
      )
    is WearStatusUiState.Ready ->
      if (state.gatewayConnected) {
        StatusPresentation(
          titleRes = R.string.phone_ready,
          detailRes = R.string.gateway_connected,
          indicatorColor = OpenClawGreen,
        )
      } else {
        StatusPresentation(
          titleRes = R.string.phone_ready,
          detailRes = R.string.gateway_offline,
          indicatorColor = OpenClawRed,
        )
      }
    WearStatusUiState.PhoneNotReady ->
      StatusPresentation(
        titleRes = R.string.open_phone_app,
        detailRes = R.string.phone_not_ready_detail,
        indicatorColor = OpenClawRed,
      )
    WearStatusUiState.PhoneUnavailable ->
      StatusPresentation(
        titleRes = R.string.phone_unavailable,
        detailRes = R.string.phone_unavailable_detail,
        indicatorColor = OpenClawRed,
      )
    WearStatusUiState.Incompatible ->
      StatusPresentation(
        titleRes = R.string.update_required,
        detailRes = R.string.update_required_detail,
        indicatorColor = OpenClawRed,
      )
  }

private val OpenClawBackground = Color(0xFF07080A)
private val OpenClawPanel = Color(0xFF17191F)
private val OpenClawRed = Color(0xFFFF4D5A)
private val OpenClawCyan = Color(0xFF70DDF2)
private val OpenClawGreen = Color(0xFF68D391)
private val OpenClawMuted = Color(0xFFB7BAC2)
