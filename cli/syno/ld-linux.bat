@echo off
C:\Users\leotwang\.rustup\toolchains\stable-x86_64-pc-windows-msvc\lib\rustlib\x86_64-pc-windows-msvc\bin\rust-lld.exe -flavor gnu %*
exit /b %ERRORLEVEL%
