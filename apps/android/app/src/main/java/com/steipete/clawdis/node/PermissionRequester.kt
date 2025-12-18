package com.steipete.clawdis.node

import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

class PermissionRequester(private val activity: ComponentActivity) {
  private val mutex = Mutex()
  private var pending: CompletableDeferred<Map<String, Boolean>>? = null

  private val launcher: ActivityResultLauncher<Array<String>> =
    activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
      val p = pending
      pending = null
      p?.complete(result)
    }

  suspend fun requestIfMissing(
    permissions: List<String>,
    timeoutMs: Long = 20_000,
  ): Map<String, Boolean> =
    mutex.withLock {
      val missing =
        permissions.filter { perm ->
          ContextCompat.checkSelfPermission(activity, perm) != PackageManager.PERMISSION_GRANTED
        }
      if (missing.isEmpty()) {
        return permissions.associateWith { true }
      }

      val deferred = CompletableDeferred<Map<String, Boolean>>()
      pending = deferred
      withContext(Dispatchers.Main) {
        launcher.launch(missing.toTypedArray())
      }

      val result =
        withContext(Dispatchers.Default) {
          kotlinx.coroutines.withTimeout(timeoutMs) { deferred.await() }
        }

      // Merge: if something was already granted, treat it as granted even if launcher omitted it.
      return permissions.associateWith { perm ->
        val nowGranted =
          ContextCompat.checkSelfPermission(activity, perm) == PackageManager.PERMISSION_GRANTED
        result[perm] == true || nowGranted
      }
    }
}

