# Bouncy Castle - keep ALL classes (needed for Ed25519 crypto)
-keep class org.bouncycastle.** { *; }
-keep class org.bouncycastle.jce.provider.BouncyCastleProvider { *; }
-dontwarn org.bouncycastle.**

# OkHttp
-keep class okhttp3.** { *; }
-dontwarn okhttp3.**
-keep class okio.** { *; }
-dontwarn okio.**

# Keep ALL app classes (gateway, protocol, etc.)
-keep class ai.openclaw.android.** { *; }

# Keep Java security/crypto classes used by Ed25519
-keep class java.security.** { *; }
-keep class javax.crypto.** { *; }

# Generated missing rules
-dontwarn com.sun.jna.Library
-dontwarn com.sun.jna.Memory
-dontwarn com.sun.jna.Native
-dontwarn com.sun.jna.Pointer
-dontwarn com.sun.jna.Structure$ByReference
-dontwarn com.sun.jna.Structure$FieldOrder
-dontwarn com.sun.jna.Structure
-dontwarn com.sun.jna.WString
-dontwarn com.sun.jna.platform.win32.Win32Exception
-dontwarn com.sun.jna.ptr.IntByReference
-dontwarn com.sun.jna.win32.W32APIOptions
-dontwarn javax.naming.NamingException
-dontwarn javax.naming.directory.DirContext
-dontwarn javax.naming.directory.InitialDirContext
-dontwarn lombok.Generated
-dontwarn org.slf4j.impl.StaticLoggerBinder
-dontwarn sun.net.spi.nameservice.NameServiceDescriptor
