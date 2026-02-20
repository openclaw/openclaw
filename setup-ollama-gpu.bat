@echo off
REM OpenClaw + Ollama GGUF GPU セットアップ (Windows Batch)

set MODEL_PATH=C:/Users/downl/Desktop/SO8T/gguf_models/lmstudio-community/rnj-1-instruct-GGUF/rnj-1-instruct-Q4_K_M.gguf
set MODEL_NAME=rnj-1-instruct

echo ========================================
echo   OpenClaw Ollama GPU Auto Setup
echo ========================================
echo.

REM Step 1: Ollama起動
echo [Step 1/5] Ollamaサービスを起動中...
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I /N "ollama.exe" >NUL
if %ERRORLEVEL% NEQ 0 (
    echo   Ollamaをバックグラウンド起動...
    start /B ollama serve >nul 2>&1
    timeout /t 5 /nobreak >nul
    echo   [OK] Ollama起動完了
) else (
    echo   [OK] Ollama既に稼働中
)

REM Step 2: 環境変数
echo.
echo [Step 2/5] 環境変数を設定中...
setx OLLAMA_API_KEY "anything" /M
setx OLLAMA_GPU "1" /M
echo   [OK] OLLAMA_API_KEY=anything
echo   [OK] OLLAMA_GPU=1

REM Step 3: モデルインポート
echo.
echo [Step 3/5] GGUFモデルをインポート中...
if not exist "%MODEL_PATH%" (
    echo   [ERROR] モデルファイルが見つかりません
    echo   %MODEL_PATH%
    exit /b 1
)

REM Modelfile作成
set MODFILE=%TEMP%\%MODEL_NAME%-Modelfile
(
    echo FROM %MODEL_PATH%
    echo PARAMETER temperature 0.7
    echo PARAMETER top_p 0.9
) > "%MODFILE%"

echo   Modelfile作成完了

REM 既存モデル削除
ollama rm %MODEL_NAME% 2>nul

REM モデルインポート
echo   モデルをインポート中... (数分かかる場合があります)
set OLLAMA_GPU=1
ollama create %MODEL_NAME% -f "%MODFILE%"
del "%MODFILE%" 2>nul

echo   [OK] モデルインポート完了

REM Step 4: OpenClaw設定
echo.
echo [Step 4/5] OpenClaw設定中...
set OLLAMA_API_KEY=anything

REM pnpmでOpenClaw CLI実行
cd /d "%~dp0"
call pnpm exec openclaw config set agents.defaults.model.primary "ollama/%MODEL_NAME%" 2>nul
echo   [OK] agents.defaults.model.primary = ollama/%MODEL_NAME%

REM Step 5: 完了
echo.
echo ========================================
echo   セットアップ完了!
echo ========================================
echo.
echo 次のステップ:
echo   1. openclaw restart
echo.
echo GPU確認:
echo   ollama run %MODEL_NAME% "Hello"
