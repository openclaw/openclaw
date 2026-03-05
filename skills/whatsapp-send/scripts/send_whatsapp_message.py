import sys
import os
import subprocess
import urllib.parse

def send_whatsapp_message(phone_number: str, message: str):
    if not phone_number or not message:
        print("Error: Both phone number and message are required.")
        sys.exit(1)

    # URL 인코딩
    encoded_message = urllib.parse.quote_plus(message)
    whatsapp_url = f"whatsapp://send?phone={phone_number}&text={encoded_message}"

    # macOS 'open' 명령어로 WhatsApp 앱을 열고 메시지를 작성
    open_command = f"open \"{whatsapp_url}\"

    # 텍스트를 모두 지우고 새 메시지를 입력한 후 전송하는 AppleScript
    # Note: 이 스크립트는 WhatsApp 앱이 전면에 활성화되고, 메시지 입력 필드가
    # 바로 접근 가능한 상태임을 가정합니다. 보안 설정에 따라 권한이 필요할 수 있습니다.
    applescript_command = f"'tell application \"System Events\" to keystroke \"a\" using command down' && osascript -e 'tell application \"System Events\" to keystroke (ASCII character 8)' && osascript -e 'tell application \"System Events\" to keystroke \"{message}\"' && sleep 0.5 && osascript -e 'tell application \"System Events\" to keystroke return'"

    # 최종적으로 실행할 전체 Bash 명령어
    full_command = f"{open_command} && sleep 3 && osascript -e {applescript_command}"

    print(f"Executing: {full_command}")
    try:
        # subprocess.run을 사용하여 외부 명령 실행
        # shell=True는 권장되지 않지만, 복합적인 셸 명령(&&)을 위해 사용
        # text=True는 출력을 텍스트로 처리
        result = subprocess.run(full_command, shell=True, check=True, capture_output=True, text=True)
        print("✅ WhatsApp 메시지 전송 스크립트 실행 완료.")
        if result.stdout:
            print("Stdout:", result.stdout)
        if result.stderr:
            print("Stderr:", result.stderr)
    except subprocess.CalledProcessError as e:
        print(f"🚨 Error executing WhatsApp message script: {e}")
        print("Stdout:", e.stdout)
        print("Stderr:", e.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"🚨 An unexpected error occurred: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python send_whatsapp_message.py <phone_number> <message>")
        sys.exit(1)

    phone_number = sys.argv[1]
    message = sys.argv[2]

    send_whatsapp_message(phone_number, message)