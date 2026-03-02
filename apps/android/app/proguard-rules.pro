# ── App classes ───────────────────────────────────────────────────
-keep class ai.openclaw.android.** { *; }

# ── Bouncy Castle ─────────────────────────────────────────────────
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**

# ── CameraX ───────────────────────────────────────────────────────
-keep class androidx.camera.** { *; }

# ── kotlinx.serialization ────────────────────────────────────────
-keep class kotlinx.serialization.** { *; }
-keepclassmembers class * {
    @kotlinx.serialization.Serializable *;
}
-keepattributes *Annotation*, InnerClasses

# ── OkHttp ────────────────────────────────────────────────────────
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.internal.platform.** { *; }

# ── Misc suppressions ────────────────────────────────────────────
-dontwarn com.sun.jna.**
-dontwarn javax.naming.**
-dontwarn lombok.Generated
-dontwarn org.slf4j.impl.StaticLoggerBinder
-dontwarn sun.net.spi.nameservice.NameServiceDescriptor
