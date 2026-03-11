# https://github.com/ram133/openclaw/filter.py
# Path: ~/Desktop/openclaw/filter.py
# Action: Autonomously filter system mail for errors only

import os

def filter_mail():
    mail_path = "/var/mail/cliffordhackett"
    if not os.path.exists(mail_path):
        return

    with open(mail_path, "r") as f:
        lines = f.readlines()

    # Only keep lines that indicate a CRITICAL error or FAILURE
    error_logs = [line for line in lines if "error" in line.lower() or "fail" in line.lower() or "permission denied" in line.lower()]

    if not error_logs:
        # If everything was a success, wipe the mail file
        with open(mail_path, "w") as f:
            f.write("")
        print("Action: Filter. Result: Success logs purged. Terminal stays clean.")
    else:
        # Keep only the errors for you to see
        with open(mail_path, "w") as f:
            f.writelines(error_logs)
        print("Action: Filter. Result: Errors preserved for review.")

if __name__ == "__main__":
    filter_mail()
