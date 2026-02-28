# Purge macOS/iOS remnants to fix sandbox-exec issue

$targets = @(
    "d:\Vorteke\node_modules\@react-native-async-storage\async-storage\ios",
    "d:\Vorteke\node_modules\@react-native-async-storage\async-storage\macos",
    "d:\Vorteke\node_modules\usb\libusb\Xcode\libusb.xcodeproj",
    "d:\AETERNA\frontend\node_modules\@react-native-async-storage\async-storage\macos",
    "d:\AETERNA\frontend\node_modules\@react-native-async-storage\async-storage\ios",
    "d:\AETERNA\frontend\node_modules\usb\libusb\Xcode\libusb.xcodeproj",
    "d:\Titan consulting\titan-protocol\node_modules\@react-native-async-storage\async-storage\macos",
    "d:\Titan consulting\titan-protocol\node_modules\@react-native-async-storage\async-storage\ios",
    "d:\Titan consulting\titan-protocol\node_modules\usb\libusb\Xcode\libusb.xcodeproj",
    "d:\neo-bank-\node_modules\@react-native-async-storage\async-storage\macos",
    "d:\neo-bank-\node_modules\@react-native-async-storage\async-storage\ios",
    "d:\neo-bank-\node_modules\fb-dotslash\bin\macos",
    "d:\neo-bank-\node_modules\react-native\ReactApple",
    "d:\neo-bank-\node_modules\react-native\Libraries\ReactNativeDependencies\Package.swift"
)

foreach ($target in $targets) {
    if (Test-Path $target) {
        Write-Host "Removing $target ..." -ForegroundColor Yellow
        Remove-Item -Path $target -Recurse -Force
    }
}

Write-Host "`nPurge complete. Please restart the assistant (IDE) now." -ForegroundColor Green
