def send_email(content):
    sender = os.getenv("MAIL_USERNAME")
    password = os.getenv("MAIL_PASSWORD")
    recipients = ["admin@ray.services", "Vewu327qaxi@post.wordpress.com"]

    msg = MIMEMultipart()
    msg['From'] = f"Ray-V Automation <{sender}>"
    msg['To'] = ", ".join(recipients)
    msg['Subject'] = "Weekly Public Domain Monetization Report"
    msg.attach(MIMEText(content, 'plain'))

    with smtplib.SMTP('smtp.gmail.com', 587) as server:
        server.starttls()
        server.login(sender, password)
        server.send_message(msg)
