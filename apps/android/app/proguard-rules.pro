# ── Bouncy Castle (Ed25519 only) ──────────────────────────────────
# Keep only the JCA provider entry point and the Ed25519 / EdDSA classes.
# R8 will strip the rest (PQC, CMS, PKCS, etc.) saving ~1 MB.
-keep class org.bouncycastle.jce.provider.BouncyCastleProvider { *; }
-keep class org.bouncycastle.jcajce.** { *; }
-keep class org.bouncycastle.crypto.signers.Ed25519Signer { *; }
-keep class org.bouncycastle.crypto.params.Ed25519** { *; }
-keep class org.bouncycastle.math.ec.rfc8032.** { *; }
-keep class org.bouncycastle.asn1.edec.** { *; }
-keep class org.bouncycastle.asn1.x509.** { *; }
-keep class org.bouncycastle.asn1.pkcs.** { *; }
-keep class org.bouncycastle.asn1.** { *; }
-dontwarn org.bouncycastle.**

# ── OkHttp ────────────────────────────────────────────────────────
-dontwarn okhttp3.**
-dontwarn okio.**
# OkHttp uses reflection for platform adapters
-keep class okhttp3.internal.platform.** { *; }

# ── App classes ───────────────────────────────────────────────────
# Don't blanket-keep; let R8 remove unused code.
# Keep classes used via reflection / serialization:
-keep class ai.openclaw.android.gateway.** { *; }
-keep class ai.openclaw.android.protocol.** { *; }

# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class ** {
    @kotlinx.serialization.Serializable *;
}

# ── Misc suppressions ────────────────────────────────────────────
-dontwarn com.sun.jna.**
-dontwarn javax.naming.**
-dontwarn lombok.Generated
-dontwarn org.slf4j.impl.StaticLoggerBinder
-dontwarn sun.net.spi.nameservice.NameServiceDescriptor
