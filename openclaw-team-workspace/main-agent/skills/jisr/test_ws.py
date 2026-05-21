import asyncio
import os

import websockets


async def test():
    try:
        async with websockets.connect(
            os.environ["CUA_SERVICE_WEBSOCKET"],
            user_agent_header="Mozilla/5.0",
        ) as ws:
            print("Connected without origin")
    except Exception as e:
        print("Error:", e)


asyncio.run(test())
